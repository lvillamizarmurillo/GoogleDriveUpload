import sql from 'mssql'
import 'dotenv/config'

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true 
  }
};

const pool = new sql.ConnectionPool(dbConfig);
const poolConnect = pool.connect();

export { sql, pool, poolConnect };