/** KV key layout for YouTube state, namespaced per user like the dev: prefix. */
export function youtubeKeyPrefix(userId: string): string {
  return `yt:${userId}:`;
}

export const ytKeys = {
  refreshToken: (userId: string) => `${youtubeKeyPrefix(userId)}refresh_token`,
  accessToken: (userId: string) => `${youtubeKeyPrefix(userId)}access_token`,
  changelog: (userId: string) => `${youtubeKeyPrefix(userId)}changelog`,
  quota: (userId: string, day: string) => `${youtubeKeyPrefix(userId)}quota:${day}`,
};
