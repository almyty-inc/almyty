/** The call was refused because the run may not use the account the tool signs in with. */
export function isNoAccessError(error: unknown): boolean {
  const e = error as any;
  const code = e?.code ?? e?.response?.code ?? e?.getResponse?.()?.code;
  return code === 'CONNECTION_NOT_GRANTED' || code === 'CONNECTION_NOT_FOUND' || code === 'CREDENTIAL_NOT_FOUND';
}

/**
 * What a tool answers when its run has no access to the service: a plain
 * sentence the agent can repeat, never something that reads like an empty
 * result.
 */
export function noAccessMessage(service: string): string {
  return `I don't have access to ${service}. Someone who manages this agent can give it access on its page, under Access.`;
}
