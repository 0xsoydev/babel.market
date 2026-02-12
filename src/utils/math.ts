export function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function randomChoice<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

export function randomChance(probability: number): boolean {
  return Math.random() < probability;
}

export function addDecimals(a: string, b: string): string {
  return (parseFloat(a) + parseFloat(b)).toFixed(2);
}

export function subtractDecimals(a: string, b: string): string {
  return (parseFloat(a) - parseFloat(b)).toFixed(2);
}

export function multiplyDecimals(a: string, b: string | number): string {
  return (parseFloat(a) * (typeof b === 'string' ? parseFloat(b) : b)).toFixed(2);
}

export function compareDecimals(a: string, b: string): number {
  const diff = parseFloat(a) - parseFloat(b);
  if (diff > 0) return 1;
  if (diff < 0) return -1;
  return 0;
}

export function formatDecimal(value: string | number, decimals: number = 2): string {
  return parseFloat(String(value)).toFixed(decimals);
}
