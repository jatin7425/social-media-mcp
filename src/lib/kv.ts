export function developmentKeyPrefix(userId: string): string {
  return `dev:${userId}:`;
}

export function developmentTestKey(userId: string): string {
  return `${developmentKeyPrefix(userId)}kv-test`;
}

export async function listDevelopmentKeys(
  kv: KVNamespace,
  userId: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({
      prefix: developmentKeyPrefix(userId),
      cursor,
    });
    keys.push(...result.keys.map(({ name }) => name));
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return keys;
}

export async function clearDevelopmentKeys(
  kv: KVNamespace,
  userId: string,
): Promise<number> {
  const keys = await listDevelopmentKeys(kv, userId);
  await Promise.all(keys.map((key) => kv.delete(key)));
  return keys.length;
}
