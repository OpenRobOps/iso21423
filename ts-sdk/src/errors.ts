export class Iso21423Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends Iso21423Error {}

export class IllegalTransition extends Iso21423Error {}

/** Emitted by an {@link MqttHandoff} when an inbound message has no route to the domain model. */
export class UnrecognizedTopicError extends Iso21423Error {}
