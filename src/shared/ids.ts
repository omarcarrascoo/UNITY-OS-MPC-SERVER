import { randomUUID } from 'crypto';

export function createEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

