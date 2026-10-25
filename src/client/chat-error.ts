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
  if (/monthly AI budget/i.test(message))
    return {
      title: 'The shared monthly AI budget is used up',
      text: 'Paid models have paused for all users until next month. Free-only models remain available. An administrator can review usage.',
      retry: false,
    };
  if (/budget|daily|spend|request would exceed/i.test(message))
    return {
      title: 'Your AI spending limit was reached',
      text: 'Generation stopped to protect your budget. An administrator can review AI consumption and limits, or you can wait for the daily allowance to reset.',
      retry: false,
    };
  if (/time limit|timeout|timed out/i.test(message))
    return {
      title: 'The AI took too long to respond',
      text: 'The request exceeded its time allowance. Any visible answer is saved. Try a smaller part or another model; continuing may use additional credits.',
      retry: true,
    };
  if (/readable answer/i.test(message))
    return {
      title: 'The model returned no usable answer',
      text: 'The provider finished without a readable response. Try another model in Chat options. Your request remains saved.',
      retry: true,
    };
  if (/output limit/i.test(message))
    return {
      title: 'The answer reached its length limit',
      text: 'The visible answer is saved. Continue the saved request or ask for the remaining work in smaller parts. Continuing may use additional credits.',
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
