/** Release acceptance remains closed. Development access requires an explicit route opt-in. */
export function timelineDevelopmentAccess(isDevelopment: boolean, requested: unknown): boolean {
  return isDevelopment && requested === '1';
}
