import { interpretRoute, routingContextFromProviders, type InterpretResult } from '@/lib/routing/routeRulesApi';

type ChatRouteOutcome =
  | { status: 'applied'; summary: string }
  | { status: 'needs-choice' }
  | { status: 'unknown'; reason: string };

export const chatRouteOutcome = (result: InterpretResult): ChatRouteOutcome => {
  if (result.status === 'applied') return { status: 'applied', summary: result.summary };
  if (result.status === 'clarify') return { status: 'needs-choice' };
  return { status: 'unknown', reason: result.reason };
};

export const applyChatRoute = async (
  sentence: string,
  providers: ReadonlyArray<{ id: string; models: ReadonlyArray<{ id: string }> }>,
): Promise<ChatRouteOutcome> => chatRouteOutcome(await interpretRoute(sentence, routingContextFromProviders(providers)));
