import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';

// 🔧 Forzar carga absoluta del .env
dotenv.config({ path: path.resolve('/opt/telephony-core/.env') });

console.log('🌍 Variables cargadas (debug):', {
    DB_SERVER: process.env.DB_SERVER,
    MSSQL_SERVER: process.env.MSSQL_SERVER,
});

const config = {
    server: process.env.DB_SERVER || process.env.MSSQL_SERVER,
    user: process.env.DB_USER || process.env.MSSQL_USER,
    password: process.env.DB_PASS || process.env.MSSQL_PASSWORD,
    database: process.env.DB_NAME || process.env.MSSQL_DATABASE,
    port: parseInt(process.env.DB_PORT || 1433, 10),
    options: {
        encrypt: false,
        trustServerCertificate: true,
    },
    pool: {
        max: 10,
        min: 1,
        idleTimeoutMillis: 30000,
    },
};

const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log('✅ MSSQL conectado:', config.database);
        return pool;
    })
    .catch(err => console.error('❌ Error MSSQL:', err));

export { sql, poolPromise };
