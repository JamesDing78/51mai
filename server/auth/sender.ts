export type VerificationPurpose = 'code_login' | 'reset_password';

export interface VerificationSendInput {
  destination: string;
  code: string;
  purpose: VerificationPurpose;
}

export interface VerificationSender {
  send(input: VerificationSendInput): Promise<void>;
}

export class VerificationSenderUnavailableError extends Error {
  readonly code = 'VERIFICATION_SENDER_UNAVAILABLE';

  constructor() {
    super('Verification sender is unavailable');
    this.name = 'VerificationSenderUnavailableError';
  }
}

/**
 * The production default deliberately fails closed until a real provider is configured.
 * It never creates or exposes a development verification code.
 */
export class UnavailableSender implements VerificationSender {
  async send(_input: VerificationSendInput): Promise<void> {
    throw new VerificationSenderUnavailableError();
  }
}
