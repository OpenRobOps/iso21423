/** Base class for all errors this SDK throws; `name` is set to the concrete subclass name so it survives serialization. */
export class Iso21423Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when a payload fails ISO 21423 JSON Schema validation; `errors` holds the raw Ajv error list. */
export class ValidationError extends Iso21423Error {
  constructor(message: string, public readonly errors: unknown[]) {
    super(message);
  }
}

/** Thrown when a request/detail reaches a terminal failure state; `finalStatus` carries the last status received. */
export class RequestFailed extends Iso21423Error {
  constructor(message: string, public readonly finalStatus: unknown) {
    super(message);
  }
}

export class RequestTimeout extends Iso21423Error {}
export class BrokerUnavailable extends Iso21423Error {}

/** Thrown when a broker/ACL rejects a publish or subscribe; `topic` names the topic that was denied. */
export class AuthorizationDenied extends Iso21423Error {
  constructor(message: string, public readonly topic: string) {
    super(message);
  }
}

export class NotCapableError extends Iso21423Error {}
/** Thrown by {@link Lifecycle.transition} when the requested state change isn't allowed from the current state. */
export class IllegalTransition extends Iso21423Error {}
