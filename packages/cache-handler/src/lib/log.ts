type LogLevel = 'error' | 'warn' | 'info' | 'silent';
type MessageLevel = 'error' | 'warn' | 'info';

function configuredLevel(): LogLevel {
  const raw = process.env.CACHE_HANDLER_LOG_LEVEL?.toLowerCase();
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'silent') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'warn' : 'info';
}

function shouldLog(messageLevel: MessageLevel): boolean {
  const level = configuredLevel();
  if (level === 'silent') {
    return false;
  }
  if (messageLevel === 'error') {
    return true;
  }
  if (level === 'error') {
    return false;
  }
  if (messageLevel === 'warn') {
    return level === 'warn' || level === 'info';
  }
  return level === 'info';
}

/** Env-gated stderr logging shared by remote and ISR handlers. */
export function cacheLog(prefix: string, messageLevel: MessageLevel, message: string): void {
  if (!shouldLog(messageLevel)) {
    return;
  }
  const line = `[${prefix}] ${message}`;
  if (messageLevel === 'error') {
    console.error(line);
  } else if (messageLevel === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
