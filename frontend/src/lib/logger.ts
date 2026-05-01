type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

type LogFields = Record<string, unknown>

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
}

const configuredLevel = normalizeLevel(process.env.NEXT_PUBLIC_LOG_LEVEL)
const configuredFormat = (process.env.NEXT_PUBLIC_LOG_FORMAT || 'text').toLowerCase()
const serviceName = process.env.NEXT_PUBLIC_SERVICE_NAME || 'aims-frontend'
const envName = process.env.NEXT_PUBLIC_ENV || process.env.NODE_ENV || 'dev'

function normalizeLevel(value: string | undefined): LogLevel {
  const normalized = value?.toLowerCase()
  if (
    normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error' ||
    normalized === 'fatal'
  ) {
    return normalized
  }
  return 'info'
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel]
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`
  }
  return String(error)
}

function compact(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null)
  )
}

function emit(level: LogLevel, loggerName: string, msg: string, fields: LogFields = {}) {
  if (!shouldLog(level)) return

  const ts = new Date().toISOString()
  const payload = compact({
    ts,
    timestamp: ts,
    level,
    severity_text: level.toUpperCase(),
    service: serviceName,
    'service.name': serviceName,
    env: envName,
    logger: loggerName,
    'logger.name': loggerName,
    msg,
    body: msg,
    ...fields,
  })

  const method = level === 'debug' ? 'debug' : level === 'info' ? 'log' : level === 'warn' ? 'warn' : 'error'
  if (configuredFormat === 'json') {
    console[method](JSON.stringify(payload))
    return
  }

  const suffix = Object.entries(payload)
    .filter(([key]) => !['ts', 'timestamp', 'level', 'severity_text', 'msg', 'body'].includes(key))
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  console[method](`${ts} ${level} msg=${msg}${suffix ? ` ${suffix}` : ''}`)
}

export function createLogger(loggerName: string) {
  return {
    debug: (msg: string, fields?: LogFields) => emit('debug', loggerName, msg, fields),
    info: (msg: string, fields?: LogFields) => emit('info', loggerName, msg, fields),
    warn: (msg: string, fields?: LogFields) => emit('warn', loggerName, msg, fields),
    error: (msg: string, fields?: LogFields & { error?: unknown }) => {
      const { error, ...rest } = fields || {}
      emit('error', loggerName, msg, compact({ ...rest, exc_info: error ? serializeError(error) : undefined }))
    },
    fatal: (msg: string, fields?: LogFields & { error?: unknown }) => {
      const { error, ...rest } = fields || {}
      emit('fatal', loggerName, msg, compact({ ...rest, exc_info: error ? serializeError(error) : undefined }))
    },
  }
}
