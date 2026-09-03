// Husker scrollposition pr. fil og visning, så et faneskift ikke hopper
// til toppen. Lever kun i hukommelsen og nulstilles ved genstart.
type ViewKind = "markdown" | "layout";

const positions = new Map<string, number>();

export function saveScroll(path: string, view: ViewKind, top: number) {
  positions.set(`${view}:${path}`, top);
}

export function getScroll(path: string, view: ViewKind): number | undefined {
  return positions.get(`${view}:${path}`);
}
