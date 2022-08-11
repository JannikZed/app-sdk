import { Actions } from "./actions";
import { AppBridgeState, AppBridgeStateContainer } from "./app-bridge-state";
import { SSR } from "./constants";
import { Events, EventType, PayloadOfEvent, ThemeType } from "./events";

const DISPATCH_RESPONSE_TIMEOUT = 1000;

type EventCallback<TPayload extends {} = {}> = (data: TPayload) => void;
type SubscribeMap = {
  [type in EventType]: Record<symbol, EventCallback<PayloadOfEvent<type>>>;
};

function eventStateReducer(state: AppBridgeState, event: Events) {
  switch (event.type) {
    case EventType.handshake: {
      return {
        ...state,
        ready: true,
        token: event.payload.token,
      };
    }
    case EventType.redirect: {
      return {
        ...state,
        path: event.payload.path,
      };
    }
    case EventType.theme: {
      return {
        ...state,
        theme: event.payload.theme,
      };
    }
    case EventType.response: {
      return state;
    }
    default: {
      /**
       * Event comes from API, so always assume it can be something not covered by TS
       */
      console.warn(`Invalid event received: ${(event as any)?.type}`);
      return state;
    }
  }
}

const createEmptySubscribeMap = (): SubscribeMap => ({
  handshake: {},
  response: {},
  redirect: {},
  theme: {},
});

export class AppBridge {
  private state = new AppBridgeStateContainer();

  private refererOrigin = new URL(document.referrer).origin;

  private subscribeMap = createEmptySubscribeMap();

  constructor(private targetDomain?: string) {
    if (SSR) {
      throw new Error(
        "AppBridge detected you're running this app in SSR mode. Make sure to call `new AppBridge()` when window object exists."
      );
    }

    if (!targetDomain) {
      this.targetDomain = new URL(window.location.href).searchParams.get("domain") || "";
    }

    if (!this.refererOrigin) {
      // TODO probably throw
      console.warn("document.referrer is empty");
    }

    this.setInitialState();
    this.listenOnMessages();
  }

  /**
   * Subscribes to an Event.
   *
   * @param eventType - Event type.
   * @param cb - Callback that executes when Event is registered. Called with Event payload object.
   * @returns Unsubscribe function. Call to unregister the callback.
   */
  subscribe<TEventType extends EventType, TPayload extends PayloadOfEvent<TEventType>>(
    eventType: TEventType,
    cb: EventCallback<TPayload>
  ) {
    const key = Symbol("Callback token");
    // @ts-ignore fixme
    this.subscribeMap[eventType][key] = cb;

    return () => {
      delete this.subscribeMap[eventType][key];
    };
  }

  /**
   * Unsubscribe to all Events of type.
   * If type not provider, unsubscribe all
   *
   * @param eventType - (optional) Event type. If empty, all callbacks will be unsubscribed.
   */
  unsubscribeAll(eventType?: EventType) {
    if (eventType) {
      this.subscribeMap[eventType] = {};
    } else {
      this.subscribeMap = createEmptySubscribeMap();
    }
  }

  /**
   * Dispatch event to dashboard
   */
  async dispatch<T extends Actions>(action: T) {
    return new Promise<void>((resolve, reject) => {
      if (!window.parent) {
        reject(new Error("Parent window does not exist."));
      } else {
        window.parent.postMessage(
          {
            type: action.type,
            payload: action.payload,
          },
          "*"
        );

        let intervalId: number;

        const unsubscribe = this.subscribe(EventType.response, ({ actionId, ok }) => {
          if (action.payload.actionId === actionId) {
            unsubscribe();
            clearInterval(intervalId);

            if (ok) {
              resolve();
            } else {
              reject(
                new Error(
                  "Action responded with negative status. This indicates the action method was not used properly."
                )
              );
            }
          }
        });

        intervalId = window.setInterval(() => {
          unsubscribe();
          reject(new Error("Action response timed out."));
        }, DISPATCH_RESPONSE_TIMEOUT);
      }
    });
  }

  /**
   * Gets current state
   */
  getState() {
    return this.state.getState();
  }

  private setInitialState() {
    const url = new URL(window.location.href);
    const id = url.searchParams.get("id") || "";
    const path = window.location.pathname || "";
    const theme: ThemeType = url.searchParams.get("theme") === "light" ? "light" : "dark";

    this.state.setState({ domain: this.targetDomain, id, path, theme });
  }

  private listenOnMessages() {
    window.addEventListener(
      "message",
      ({ origin, data }: Omit<MessageEvent, "data"> & { data: Events }) => {
        if (origin !== this.refererOrigin) {
          // TODO what should happen here - be explicit
          return;
        }

        const newState = eventStateReducer(this.state.getState(), data);
        this.state.setState(newState);

        /**
         * TODO Validate and warn/throw
         */
        const { type, payload } = data;

        if (EventType[type]) {
          Object.getOwnPropertySymbols(this.subscribeMap[type]).forEach((key) =>
            // @ts-ignore fixme
            this.subscribeMap[type][key](payload)
          );
        }
      }
    );
  }
}
