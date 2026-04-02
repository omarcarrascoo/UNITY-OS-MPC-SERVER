export function isFatalToolError(toolResult: string): boolean {
  const fatalMarkers = [
    'SECURITY EXCEPTION',
    'Path is outside repo root',
    'Blocked unsafe path',
    'Unsupported tool',
    'Empty command',
  ];

  return fatalMarkers.some((marker) => toolResult.includes(marker));
}

export function isFatalRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return ['AbortError', 'Model returned an empty response.'].some((marker) =>
    message.includes(marker),
  );
}

export function countBroadExplorationCalls(toolHistory: string[]): number {
  const broadPatterns = [
    /^search_project:menu$/i,
    /^search_project:register$/i,
    /^search_project:origin$/i,
  ];

  return toolHistory.filter((entry) =>
    broadPatterns.some((pattern) => pattern.test(entry)),
  ).length;
}

export function hasEnoughTargetEvidence(toolHistory: string[]): boolean {
  const usefulSignals = [
    'read_file:',
    'search_project:KuboHomeHeader',
    'search_project:Header',
    'search_project:register-studio',
    'search_project:register',
  ];

  let score = 0;

  for (const entry of toolHistory) {
    if (usefulSignals.some((signal) => entry.includes(signal))) {
      score += 1;
    }
  }

  return score >= 3;
}

