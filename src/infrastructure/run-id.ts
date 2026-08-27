import { randomBytes } from 'node:crypto';
import type { Clock, RunIdGenerator } from '../application/ports.js';

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class TimestampRunIdGenerator implements RunIdGenerator {
  public next(at: Date): string {
    const timestamp = at.toISOString().replaceAll(/[-:.]/g, '');
    return `${timestamp}-${randomBytes(4).toString('hex')}`;
  }
}
