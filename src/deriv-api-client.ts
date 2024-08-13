import { ObjectUtils, PromiseUtils } from '@deriv-com/utils';
import {
    TSocketEndpointNames,
    TSocketError,
    TSocketRequestPayload,
    TSocketResponseData,
    TSocketSubscribableEndpointNames,
    TSocketSubscribeResponseData,
} from './types/api-types';

export type DerivAPIClientOptions = {
    onOpen?: (e: Event) => void;
    onClose?: (e: CloseEvent) => void;
};

type DataHandler<T extends TSocketEndpointNames> = (data: TSocketResponseData<T>) => void;

type RequestHandler<T extends TSocketEndpointNames = TSocketEndpointNames> = {
    name: TSocketEndpointNames;
    onData: DataHandler<T>;
    onError: (error: TSocketError<T>['error']) => void;
    promise: Promise<TSocketResponseData<T>>;
};

type SubscriptionHandler<T extends TSocketSubscribableEndpointNames> = {
    name: T;
    status: 'active' | 'idle' | 'error';
    data?: TSocketSubscribeResponseData<T>;
    payload: TSocketRequestPayload<T>;
    counter: number;
    subscriptions: Map<number, (data: TSocketSubscribeResponseData<T>) => void>;
    onError?: (error: TSocketError<T>['error']) => void;
    subscription_id: string;
};

type RequestMap<T extends TSocketEndpointNames = TSocketEndpointNames> = Map<string, RequestHandler<T>>;
type SubscriptionMap<T extends TSocketSubscribableEndpointNames = TSocketSubscribableEndpointNames> = Map<
    string,
    SubscriptionHandler<T>
>;

export type SendFunctionArgs<T extends TSocketEndpointNames> = {
    name: T;
    payload?: TSocketRequestPayload<T>;
};

export type SubscribeFunctionArgs<T extends TSocketSubscribableEndpointNames> = {
    name: T;
    payload?: TSocketRequestPayload<T>;
    onData: (data: TSocketSubscribeResponseData<T>) => void;
    onError?: (error: TSocketError<T>['error']) => void;
};

export type UnsubscribeHandlerArgs = {
    id: number;
    hash: string;
};

export class DerivAPIClient {
    websocket: WebSocket;
    requestHandler: RequestMap;
    subscribeHandler: SubscriptionMap;
    req_id: number;
    waitForWebSocketOpen: ReturnType<typeof PromiseUtils.createPromise>;
    waitForWebSocketCall?: ReturnType<typeof PromiseUtils.createPromise> & {
        name: TSocketEndpointNames;
        type: 'all' | 'subscribe' | 'request';
    };
    authorizePayload: TSocketRequestPayload<'authorize'> | null = null;
    keepAliveIntervalId: NodeJS.Timeout | null = null;

    constructor(endpoint: string, options?: DerivAPIClientOptions) {
        this.websocket = new WebSocket(endpoint);
        this.req_id = 0;
        this.requestHandler = new Map();
        this.subscribeHandler = new Map();
        this.waitForWebSocketOpen = PromiseUtils.createPromise();

        this.websocket.addEventListener('open', e => {
            if (typeof options?.onOpen === 'function') options.onOpen(e);
            const { resolve } = this.waitForWebSocketOpen;
            resolve({});
        });

        this.websocket.addEventListener('close', e => {
            if (typeof options?.onClose === 'function') options.onClose(e);
        });

        this.websocket.addEventListener('message', async response => {
            const parsedData = JSON.parse(response.data);

            // If name matches for the calls you asynchronously wait, resolve that call
            if (this.waitForWebSocketCall && parsedData.msg_type === this.waitForWebSocketCall?.name) {
                const { resolve } = this.waitForWebSocketCall;
                resolve({});
            }

            if (parsedData.subscription || parsedData.echo_req?.subscribe) {
                const { req_id, ...payload } = parsedData.echo_req;
                const subscribeHash = await ObjectUtils.hashObject({ ...payload });
                const matchingHandler = this.subscribeHandler.get(subscribeHash);
                if (!matchingHandler) return;

                if (parsedData.error && typeof matchingHandler.onError === 'function') {
                    this.subscribeHandler.delete(subscribeHash);
                    matchingHandler.onError(parsedData.error);
                    return;
                }
                matchingHandler.data = parsedData;
                if (matchingHandler.subscriptions?.size) {
                    matchingHandler.subscriptions.forEach(onData => onData(parsedData));
                }
                matchingHandler.subscription_id = parsedData?.subscription?.id ?? '';
            } else if (parsedData) {
                const id = parsedData.req_id?.toString();
                const matchingHandler = this.requestHandler.get(id);
                if (!matchingHandler) return;

                if (parsedData.error) {
                    matchingHandler.onError(parsedData.error);
                } else {
                    matchingHandler.onData(parsedData);
                }
                this.requestHandler.delete(id);
            }
        });

        this.keepAlive();
    }

    /**
     * Sends a request to the WebSocket server.
     * @template T - The type of the socket endpoint name.
     * @param {SendFunctionArgs<T>} args - The name of the endpoint and the request payload.
     * @returns {Promise<TSocketResponseData<T>>} - A promise that resolves with the response data.
     */
    async send<T extends TSocketEndpointNames>({ name, payload }: SendFunctionArgs<T>) {
        this.req_id = this.req_id + 1;
        const requestPayload = { [name]: 1, ...(payload ?? {}), req_id: this.req_id };

        // Check if there's an existing request with the same ID, and return its promise if found.
        const matchingRequest = this.requestHandler.get(this.req_id.toString());
        if (matchingRequest) return matchingRequest.promise as Promise<TSocketResponseData<T>>;

        // Create a new promise for the request and define resolve and reject handlers.
        const { promise, resolve, reject } = PromiseUtils.createPromise<TSocketResponseData<T>>();
        const newRequestHandler: RequestHandler<T> = {
            name,
            onData: data => resolve(data),
            onError: error => reject(error),
            promise,
        };

        // Store the new request handler in the request handler map.
        this.requestHandler.set(this.req_id.toString(), newRequestHandler as RequestHandler<TSocketEndpointNames>);

        // Wait for the WebSocket connection to open if it hasn't already.
        await this.waitForWebSocketOpen?.promise;

        // Wait for specific pending WebSocket calls to complete if necessary.
        if (this.waitForWebSocketCall?.type === 'request' || this.waitForWebSocketCall?.type === 'all') {
            await this.waitForWebSocketCall.promise;
        }
        this.websocket.send(JSON.stringify(requestPayload));

        if (name === 'authorize') {
            const { req_id, ...cleanedPayload } = requestPayload as TSocketRequestPayload<'authorize'> & {
                req_id: number;
            };
            this.authorizePayload = cleanedPayload;
        }

        return promise;
    }

    /**
     * Subscribes to a WebSocket endpoint.
     * @template T - The type of the socket subscribable endpoint name.
     * @param {SubscribeFunctionArgs<T>} args - The name of the endpoint, payload, and callback functions.
     * @returns {Promise<TSocketSubscribeResponseData<T>>} - A promise that resolves with the subscription response data.
     */
    async subscribe<T extends TSocketSubscribableEndpointNames>({
        name,
        payload,
        onData,
        onError,
    }: SubscribeFunctionArgs<T>): Promise<{ id: number; hash: string }> {
        const subscriptionPayload = { [name]: 1, ...(payload ?? {}), subscribe: 1 };
        const subscriptionHash = await ObjectUtils.hashObject(subscriptionPayload);
        const matchingSubscription = this.subscribeHandler.get(subscriptionHash);

        // If no existing subscription, create a new handler and send the subscribe payload
        if (!matchingSubscription) {
            this.req_id = this.req_id + 1;

            const newSubscriptionHandler: SubscriptionHandler<T> = {
                name,
                status: 'idle',
                payload: subscriptionPayload as unknown as TSocketRequestPayload<T>,
                onError: onError,
                subscriptions: new Map(),
                subscription_id: '',
                counter: 1,
            };

            newSubscriptionHandler.subscriptions.set(newSubscriptionHandler.counter, onData);
            this.subscribeHandler.set(
                subscriptionHash,
                newSubscriptionHandler as SubscriptionHandler<TSocketSubscribableEndpointNames>
            );

            await this.waitForWebSocketOpen?.promise;
            if (this.waitForWebSocketCall?.type === 'subscribe' || this.waitForWebSocketCall?.type === 'all') {
                await this.waitForWebSocketCall.promise;
            }
            this.websocket.send(JSON.stringify({ ...subscriptionPayload, req_id: this.req_id }));

            return { id: newSubscriptionHandler.counter, hash: subscriptionHash };
        } else {
            // If there is already a subscription, simply append the onData callback directly to the subscription list
            const currentCounter = matchingSubscription.counter + 1;
            matchingSubscription.subscriptions.set(
                currentCounter,
                onData as (data: TSocketSubscribeResponseData<TSocketSubscribableEndpointNames>) => void
            );
            matchingSubscription.counter = currentCounter;
            const matchingHandler = matchingSubscription.subscriptions.get(currentCounter);
            if (typeof matchingHandler === 'function' && matchingSubscription.data) {
                matchingHandler(matchingSubscription.data);
            }

            return { id: matchingSubscription.counter, hash: subscriptionHash };
        }
    }

    /**
     * Unsubscribes from a WebSocket endpoint.
     * @param {UnsubscribeHandlerArgs} args - The subscription ID and hash.
     * @returns {Promise<void>} - A promise that resolves when the unsubscription is complete.
     */
    async unsubscribe({ hash, id }: UnsubscribeHandlerArgs) {
        const matchingSubscription = this.subscribeHandler.get(hash);
        if (!matchingSubscription) return;
        matchingSubscription.subscriptions.delete(id);

        if (matchingSubscription.subscriptions.size > 0) return;
        const { subscription_id } = matchingSubscription;

        await this.waitForWebSocketOpen?.promise;
        const response = await this.send({ name: 'forget', payload: { forget: subscription_id } });
        if (response && !response.error) {
            matchingSubscription.subscriptions.clear();
            this.subscribeHandler.delete(hash);
        }
    }

    /**
     * Waits for a specific WebSocket call to complete.
     * @param {TSocketEndpointNames} name - The name of the endpoint to wait for.
     * @param {'all' | 'subscribe' | 'request'} type - The type of event to wait for.
     * @returns {Promise<void>} - A promise that resolves when the event is complete.
     */
    async waitFor(name: TSocketEndpointNames, type: 'all' | 'subscribe' | 'request') {
        this.waitForWebSocketCall = { ...PromiseUtils.createPromise(), name, type };
    }

    async reinitializeSubscriptions(
        subscribeHandler: SubscriptionMap<TSocketSubscribableEndpointNames>,
        authorizeData?: TSocketRequestPayload<'authorize'> | null
    ) {
        if (authorizeData) {
            this.authorizePayload = { ...authorizeData };
            await this.send({ name: 'authorize', payload: { ...authorizeData } });
        }

        let subscriptionList: Promise<unknown>[] = [];
        subscribeHandler.forEach(handler => {
            handler.subscriptions.forEach(onData => {
                subscriptionList.push(this.subscribe({ name: handler.name, payload: handler.payload, onData }));
            });
        });
        await Promise.all(subscriptionList);
    }

    /**
     * Unsubscribes from all active WebSocket subscriptions.
     * @returns {Promise<void>} - A promise that resolves when all subscriptions are cancelled.
     */
    async unsubscribeAll() {
        for (const subs of this.subscribeHandler.values()) {
            await this.send({ name: 'forget', payload: { forget: subs.subscription_id } });
        }
    }

    /**
     * Checks if the WebSocket is in a closed or closing state.
     * @returns {boolean} - A boolean which indicates if the WebSocket is in a closed or closing state.
     */
    isSocketClosingOrClosed() {
        return ![2, 3].includes(this.websocket.readyState);
    }

    /**
     * Disconnects the WebSocket connection if not already.
     */
    disconnect() {
        if (!this.isSocketClosingOrClosed()) {
            this.websocket.close();
        }
    }

    /**
     * Clears all pending requests and subscriptions as well as disconnects WebSocket connection.
     */
    cleanup() {
        this.requestHandler.clear();
        this.subscribeHandler.clear();
        this.disconnect();
    }

    /**
     * Keeps WebSocket connection alive by sending a ping call every 30 seconds (default).
     * @param interval
     */
    keepAlive(interval = 30000) {
        if (this.keepAliveIntervalId) {
            clearInterval(this.keepAliveIntervalId);
        }

        this.keepAliveIntervalId = setInterval(async () => {
            await this.send({ name: 'ping' });
        }, interval);
    }
}