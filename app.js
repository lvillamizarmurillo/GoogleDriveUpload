import 'dotenv/config'
import express from 'express'
import UploadRouter from './Routes/upload-comprobante.js';

const app = express();

const config = {
  hostname: process.env.LOCALHOST || 'localhost',
  port: process.env.PORT || 3005,
};

app
  .use(express.urlencoded({ extended: true }))
  .use(express.json({ limit: '50mb' })) // Middleware para procesar JSON. Se aumenta el límite por el tamaño del archivo Base64.
  .use('/api', UploadRouter)
  .listen(config.port, () => {
    console.log(`http://${config.hostname}:${config.port}`);
  });