import { Router } from 'express';
import Upload from '../Services/upload.js';

const router = Router();

// Ya no se necesita 'multer'. La petición es de tipo JSON.
router.post('/upload-comprobante', Upload.uploadFile);

export default router;