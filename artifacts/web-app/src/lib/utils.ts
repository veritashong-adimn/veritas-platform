import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return "";

  if (digits.startsWith("02")) {
    if (digits.length <= 6) return digits.replace(/(\d{2})(\d{0,4})/, "$1-$2");
    if (digits.length <= 9) return digits.replace(/(\d{2})(\d{3,4})(\d{0,4})/, "$1-$2-$3");
    return digits.replace(/(\d{2})(\d{4})(\d{4})/, "$1-$2-$3");
  }

  if (digits.length <= 7) return digits.replace(/(\d{3})(\d{0,4})/, "$1-$2");
  if (digits.length <= 10) return digits.replace(/(\d{3})(\d{3,4})(\d{0,4})/, "$1-$2-$3");
  return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3").slice(0, 13);
}
