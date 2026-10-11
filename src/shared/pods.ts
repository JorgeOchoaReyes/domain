import { DESKS, MORE_TEAM_DESK_IDS, TEAM_DESK_IDS, TEAM_FLOORS, teamPods } from "./layout.js";

/**
 * Pods for people: in a shared office each person gets a pod on the team
 * floor (a cluster of desks for them and their agents), kept by name so you
 * come back to the same one. And borrowing: a teammate asks to borrow
 * someone's agent, the owner says yes or no, and on yes it works for the
 * borrower until it's given back, called back, its task is done, or either
 * of them leaves.
 */

/** A pod and the person it's for. */
export interface PodSeat {
  /** The pod's name ("A", "B", …). */
  pod: string;
  person: string;
  /** Whether they're in the office now. */
  here: boolean;
}

/** A borrow: asked (waiting for the owner's yes or no) or lent. */
export interface Loan {
  deskId: string;
  /** The worker's id (a loan ends if the desk gets someone else). */
  workerId: string;
  /** What to call it. */
  worker: string;
  owner: string;
  borrower: string;
  state: "asked" | "lent";
  /** When it was asked for, or lent. */
  at: number;
  /** The task the borrower gave it: the loan ends when it's done. */
  taskId: string | null;
}

export interface PodsState {
  pods: PodSeat[];
  loans: Loan[];
}

/** What happened to a borrow, for the people in it. */
export type BorrowEvent = "asked" | "lent" | "declined" | "returned" | "refused";

/** How long an owner has to answer before the ask lapses. */
export const ASK_TTL_MS = 2 * 60_000;

/** Every team floor's pods (floor 3's A–D first, then floor 4's E–H, …), with their centers. */
export const ALL_PODS: readonly { name: string; x: number; z: number }[] = Array.from({ length: TEAM_FLOORS }, (_, k) => teamPods(k)).flat();
/** Every desk on a team floor. */
const ALL_TEAM_DESKS: readonly string[] = [...TEAM_DESK_IDS, ...MORE_TEAM_DESK_IDS];

/** The pods' names, in the order they're handed out: floor 3's first, then the floors above. */
export function podNames(): string[] {
  return ALL_PODS.map((p) => p.name);
}

/** The desks in a pod. */
export function podDesks(pod: string): string[] {
  return DESKS.filter((d) => ALL_TEAM_DESKS.includes(d.id) && d.label.replace(/\d+$/, "") === `Pod ${pod}`).map((d) => d.id);
}

/** Which pod a desk is in (null: not on a team floor). */
export function podOfDesk(deskId: string): string | null {
  if (!ALL_TEAM_DESKS.includes(deskId)) return null;
  const label = DESKS.find((d) => d.id === deskId)?.label ?? "";
  const m = /^Pod (\S+?)\d+$/.exec(label);
  return m ? m[1] : null;
}

/**
 * Give everyone here a pod, stably: you keep the pod you had (by name) unless
 * someone here now holds it; newcomers get a pod nobody's had, then one whose
 * person isn't here. Returns who's where (everyone remembered, here or not)
 * and the people left without one when there are more people than pods.
 */
export function assignPods(present: readonly string[], saved: Readonly<Record<string, string>>, pods: readonly string[] = podNames()): { assigned: Record<string, string>; without: string[] } {
  const people = [...new Set(present.filter(Boolean))];
  const assigned: Record<string, string> = {};
  // Remembered pods that still exist.
  for (const [person, pod] of Object.entries(saved)) if (pods.includes(pod)) assigned[person] = pod;
  const holder = (pod: string) => Object.keys(assigned).find((p) => assigned[p] === pod);
  // Two people remembered in the same pod (an old file): the first keeps it.
  const seen = new Set<string>();
  for (const p of Object.keys(assigned)) {
    if (seen.has(assigned[p])) delete assigned[p];
    else seen.add(assigned[p]);
  }
  const without: string[] = [];
  for (const person of people) {
    if (assigned[person]) continue;
    const fresh = pods.find((pod) => !holder(pod));
    const reclaim = fresh ?? pods.find((pod) => !people.includes(holder(pod)!));
    if (!reclaim) {
      without.push(person);
      continue;
    }
    const old = holder(reclaim);
    if (old) delete assigned[old];
    assigned[person] = reclaim;
  }
  return { assigned, without };
}

/** The pods as shown: one entry per remembered person, in pod order. */
export function podSeats(assigned: Readonly<Record<string, string>>, present: readonly string[], pods: readonly string[] = podNames()): PodSeat[] {
  return Object.entries(assigned)
    .map(([person, pod]) => ({ pod, person, here: present.includes(person) }))
    .sort((a, b) => pods.indexOf(a.pod) - pods.indexOf(b.pod));
}

/**
 * Whether someone may hire at a desk: anywhere off the team floor, in their
 * own pod, a pod that's nobody's, or one whose person isn't here. Returns
 * whose pod it is when they may not.
 */
export function podOwnerBlocking(deskId: string, who: string, seats: readonly PodSeat[]): string | null {
  const pod = podOfDesk(deskId);
  if (!pod) return null;
  const seat = seats.find((s) => s.pod === pod);
  return seat && seat.here && seat.person !== who ? seat.person : null;
}
