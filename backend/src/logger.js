// One JSON object per line on stdout/stderr. ECS ships both streams to CloudWatch Logs,
// and CloudWatch Logs Insights can then filter on fields like level or msg.
const serializeError = (err) =>
  err instanceof Error ? { message: err.message, code: err.code, stack: err.stack } : err;

const log = (level, msg, meta = {}) => {
  const { err, ...rest } = meta;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...rest,
    ...(err ? { err: serializeError(err) } : {}),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
};

export const logger = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
