export const log = (type, msg, data = {}) => {
    const ts = new Date().toISOString();
    const color = type === 'error' ? '\x1b[31m' : '\x1b[36m';
    console.log(`${color}${ts} [${type.toUpperCase()}]\x1b[0m ${msg}`, Object.keys(data).length ? data : '');
};
