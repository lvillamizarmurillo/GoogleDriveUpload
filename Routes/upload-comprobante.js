import { Router } from 'express';
import Upload from '../Services/upload.js';

const router = Router();

// Ruta actualizada para aceptar parámetros que controlan el flujo de ejecución
router.post('/upload/:esComprobante/:esAdjunto/:esCotizacion/:esAdjuntoActividad', Upload.uploadFile);

export default router;