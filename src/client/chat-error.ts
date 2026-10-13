export function chatError(message: string) {
  if (/max price|no endpoints|404|503|overload|429|rate.limit/i.test(message))
    return {
      title: 'The AI provider is unavailable',
      text: 'No provider could answer within your current model and price settings. Automatic mode tries one economical alternative. You can try again or choose another model in Chat options.',
      retry: true,
    };
  if (/402|credit|payment/i.test(message))
    return {
      title: 'The provider could not authorize this request',
      text: 'The provider’s credit or account limit blocked generation. An administrator can check the provider account and key limits. Reconnecting alone will not fix it.',
      retry: false,
    };
  if (/budget|daily|spend|request would exceed/i.test(message))
    return {
      title: 'Your AI spending limit was reached',
      text: 'Generation stopped to protect your budget. An administrator can review AI consumption and limits, or you can wait for the daily allowance to reset.',
      retry: false,
    };
  if (
    /output limit|readable answer|time limit|timeout|timed out/i.test(message)
  )
    return {
      title: 'The answer could not finish',
      text: 'The response reached a limit. Any visible answer remains available. Continue the saved request, ask for a smaller part, or choose another model in Chat options.',
      retry: true,
    };
  if (/401|403|unauthorized|forbidden/i.test(message))
    return {
      title: 'Access needs attention',
      text: 'Your session or the provider’s credentials were rejected. Sign in again; if it continues, ask an administrator to check access and provider settings.',
      retry: false,
    };
  if (/reasoning|400|parameter/i.test(message))
    return {
      title: 'This model could not accept the request',
      text: 'The provider rejected a model setting. Choose another model in Chat options while an administrator reviews the configuration.',
      retry: false,
    };
  return {
    title: 'The request was interrupted',
    text: 'OpenDots could not complete this step. Your conversation remains available. Try continuing the saved request; if it happens again, choose another model in Chat options.',
    retry: true,
  };
}
