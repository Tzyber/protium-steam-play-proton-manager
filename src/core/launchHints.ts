const MAX_DRAFT_LENGTH = 8192;
const COMMAND_MARKER = "%command%";
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:+,@%-]*$/;
const ARGUMENT_PATTERN = /^[A-Za-z0-9_./:+,@%=~-]+$/;
const DISALLOWED_CHARACTER = /[^A-Za-z0-9_./:+,@%=~\- \t]/;

export type LaunchHint =
  | "gamemode-missing-command"
  | "assignment-after-command"
  | "proton-log-enabled";

interface Assignment {
  name: string;
  value: string;
}

function isSeparator(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function markerPositions(draft: string): number[] {
  const positions: number[] = [];
  let searchFrom = 0;
  while (searchFrom < draft.length) {
    const position = draft.indexOf(COMMAND_MARKER, searchFrom);
    if (position < 0) break;
    positions.push(position);
    searchFrom = position + COMMAND_MARKER.length;
  }
  return positions;
}

function isCompleteMarkerToken(draft: string, position: number): boolean {
  const before = draft[position - 1];
  const after = draft[position + COMMAND_MARKER.length];
  const startsAtTokenBoundary = position === 0 || isSeparator(before);
  const endsAtTokenBoundary =
    position + COMMAND_MARKER.length === draft.length || isSeparator(after);
  return startsAtTokenBoundary && endsAtTokenBoundary;
}

function tokensOf(draft: string): string[] {
  return draft.split(/[ \t]+/).filter((token) => token.length > 0);
}

function parseAssignment(token: string): Assignment | undefined {
  if (!ASSIGNMENT_PATTERN.test(token)) return undefined;
  const separator = token.indexOf("=");
  return {
    name: token.slice(0, separator),
    value: token.slice(separator + 1),
  };
}

function isSimpleArgument(token: string): boolean {
  return ARGUMENT_PATTERN.test(token);
}

function analyzeWithoutMarker(tokens: readonly string[]): LaunchHint[] {
  if (tokens[0] !== "gamemoderun") return [];
  if (!tokens.slice(1).every(isSimpleArgument)) return [];
  return ["gamemode-missing-command"];
}

function analyzeWithMarker(tokens: readonly string[], markerIndex: number): LaunchHint[] {
  const prefix = tokens.slice(0, markerIndex);
  const suffix = tokens.slice(markerIndex + 1);
  if (!suffix.every(isSimpleArgument)) return [];

  const assignments: Assignment[] = [];
  let cursor = 0;
  while (cursor < prefix.length) {
    const assignment = parseAssignment(prefix[cursor] ?? "");
    if (assignment === undefined) break;
    assignments.push(assignment);
    cursor += 1;
  }

  if (prefix[cursor] === "env") {
    cursor += 1;
    while (cursor < prefix.length) {
      const assignment = parseAssignment(prefix[cursor] ?? "");
      if (assignment === undefined) break;
      assignments.push(assignment);
      cursor += 1;
    }
  }

  if (prefix[cursor] === "gamemoderun") cursor += 1;
  if (cursor !== prefix.length) return [];

  const assignmentNames = new Set<string>();
  for (const assignment of assignments) {
    if (assignmentNames.has(assignment.name)) return [];
    assignmentNames.add(assignment.name);
  }

  const hints: LaunchHint[] = [];
  if (suffix.some((token) => parseAssignment(token) !== undefined)) {
    hints.push("assignment-after-command");
  }
  if (
    assignments.some((assignment) => assignment.name === "PROTON_LOG" && assignment.value === "1")
  ) {
    hints.push("proton-log-enabled");
  }
  return hints;
}

export function analyzeLaunchOptions(draft: string): LaunchHint[] {
  if (draft.length > MAX_DRAFT_LENGTH) return [];

  const positions = markerPositions(draft);
  if (positions.length > 1) return [];
  const markerPosition = positions[0];
  if (markerPosition !== undefined && !isCompleteMarkerToken(draft, markerPosition)) return [];
  if (DISALLOWED_CHARACTER.test(draft)) return [];

  const tokens = tokensOf(draft);
  if (tokens.length === 0) return [];
  if (markerPosition === undefined) return analyzeWithoutMarker(tokens);

  const markerIndex = tokens.indexOf(COMMAND_MARKER);
  if (markerIndex < 0) return [];
  return analyzeWithMarker(tokens, markerIndex);
}
