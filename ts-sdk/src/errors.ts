export class Iso21423Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends Iso21423Error {
  constructor(message: string, public readonly errors: unknown[]) {
    super(message);
  }
}

export class RequestFailed extends Iso21423Error {
  constructor(message: string, public readonly finalStatus: unknown) {
    super(message);
  }
}

export class RequestTimeout extends Iso21423Error {}
export class BrokerUnavailable extends Iso21423Error {}

export class AuthorizationDenied extends Iso21423Error {
  constructor(message: string, public readonly topic: string) {
    super(message);
  }
}

export class NotCapableError extends Iso21423Error {}
export class IllegalTransition extends Iso21423Error {}
