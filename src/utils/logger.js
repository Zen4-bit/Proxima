// Proxima — Logger Factory.
// Implements structured logging with module prefixes and environment-configured log levels.

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };


let globalLevel = LOG_LEVELS[process.env.PROXIMA_LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function formatLog(level, module, message, data) {
    const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const tag = level.toUpperCase().padEnd(5);
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    return `[${time}] [${tag}] [${module}] ${message}${dataStr}`;
}

function createLogger(moduleName) {
    return {
        debug(message, data) {
            if (globalLevel <= LOG_LEVELS.debug) {
                console.error(formatLog('debug', moduleName, message, data));
            }
        },

        info(message, data) {
            if (globalLevel <= LOG_LEVELS.info) {
                console.error(formatLog('info', moduleName, message, data));
            }
        },

        warn(message, data) {
            if (globalLevel <= LOG_LEVELS.warn) {
                console.error(formatLog('warn', moduleName, message, data));
            }
        },

        error(message, data) {
            if (globalLevel <= LOG_LEVELS.error) {
                console.error(formatLog('error', moduleName, message, data));
            }
        },
    };
}

function setLogLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
        globalLevel = LOG_LEVELS[level];
    }
}

export { createLogger, setLogLevel, LOG_LEVELS };
