export function formatPhoneNumber(value: string): string {
  const numbers = value.replace(/\D/g, "");

  if (numbers.length <= 3) return numbers;
  if (numbers.length <= 7)
    return `${numbers.slice(0, 3)}-${numbers.slice(3)}`;
  if (numbers.length <= 11)
    return `${numbers.slice(0, 3)}-${numbers.slice(3, 7)}-${numbers.slice(7)}`;

  return `${numbers.slice(0, 3)}-${numbers.slice(3, 7)}-${numbers.slice(7, 11)}`;
}
