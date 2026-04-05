import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Fetch JSON from an API endpoint, throwing on non-OK responses. */
export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/** Session-level status badge classes (shared across pages). */
export const SESSION_STATUS_BADGE: Record<string, string> = {
  awaiting_approval: "bg-amber-50 text-amber-700",
  executing: "bg-blue-50 text-blue-700",
  completed: "bg-green-50 text-green-700",
  failed: "bg-red-50 text-red-700",
  planning: "bg-gray-100 text-gray-600",
};
