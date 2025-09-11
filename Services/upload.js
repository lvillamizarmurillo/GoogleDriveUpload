import { google } from 'googleapis';
import { Readable } from 'stream';
import { pool, sql } from '../db/connect.js';
import dotenv from 'dotenv';

dotenv.config();

export default class Upload {
    // --- MÉTODOS DE AUTENTICACIÓN Y AUXILIARES (Sin cambios) ---
    static getOAuth2Client() {
        const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
        const oAuth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );
        return oAuth2Client;
    }

    static generateAuthUrl() {
        const oAuth2Client = this.getOAuth2Client();
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive'],
        });
        return authUrl;
    }

    static async getTokenFromCode(code) {
        const oAuth2Client = this.getOAuth2Client();
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            return tokens;
        } catch (error) {
            console.error('[Google OAuth Error]: Error al generar el token:', error);
            throw new Error('Error al generar el token.');
        }
    }

    static async getDriveService(oAuth2Client) {
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        return drive;
    }

    static _getStageName(etapPro) {
        switch (etapPro) {
            case 1: return 'IMPLEMENTACION';
            case 2: return 'SOPORTE';
            case 3: return 'TD';
            default: return 'INDEFINIDO';
        }
    }

    static _getModelName(modEmpNom) {
        const modelNameUpper = modEmpNom.toUpperCase();
        if (modelNameUpper === 'MANTISFICCGX2') return 'MANTISFICCGX2';
        if (modelNameUpper === 'MANTISFICC') return 'MANTISFICC';
        return 'MANTIS WEB';
    }

    static async _findOrCreateFolder(drive, folderName, parentId) {
        const folderQuery = await drive.files.list({
            q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
            fields: 'files(id)',
            pageSize: 1,
        });

        if (folderQuery.data.files.length > 0) {
            console.log(`[Google Drive]: Carpeta encontrada: ${folderName}`);
            return folderQuery.data.files[0].id;
        } else {
            console.log(`[Google Drive]: Creando carpeta: ${folderName}`);
            const newFolder = await drive.files.create({
                resource: {
                    name: folderName,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: [parentId],
                },
                fields: 'id',
            });
            return newFolder.data.id;
        }
    }

    static async uploadFile(req, res) {
        try {
            console.log('[UploadFile]: Inicio del proceso de subida.');
            const oAuth2Client = Upload.getOAuth2Client();
            const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
            if (!refreshToken) {
                console.error('[Google OAuth]: Falta el GOOGLE_REFRESH_TOKEN en el archivo .env.');
                return res.status(500).json({ error: 'Error de configuración: Falta el token de refresco.' });
            }
            oAuth2Client.setCredentials({ refresh_token: refreshToken });
            const drive = await Upload.getDriveService(oAuth2Client);
            const rootFolderId = process.env.GOOGLE_FOLDER_ID;
            const poolConnect = await pool.connect();
            
            const results = {
                autorizaciones: [],
                adjuntos: []
            };

            try {
                // --- PROCESO 1: SUBIR AUTORIZACIONES (TickComFac) ---
                console.log('\n[Proceso 1]: Iniciando subida de Autorizaciones...');
                const authQueryResult = await poolConnect.request()
                    .query(`SELECT T.TickSec, T.TickComFac, E.CrmEmpNom, E.CrmEtapPro, ME.ModEmpNom
                            FROM Ticket T
                            JOIN CrmEmpresa E ON T.CrmEmpCod = E.CrmEmpCod
                          	JOIN ModelosEmpresa ME ON E.ModEmpSec = ME.ModEmpSec
                          	WHERE T.TickComFac IS NOT NULL`);
                console.log(`[Proceso 1]: Autorizaciones encontradas: ${authQueryResult.recordset.length}`);

                for (const ticket of authQueryResult.recordset) {
                    // ... (La lógica para crear carpetas y subir el archivo es idéntica a la versión anterior)
                    const { TickSec, TickComFac, CrmEmpNom, CrmEtapPro, ModEmpNom } = ticket;
                    const stageName = Upload._getStageName(CrmEtapPro);
                    const modelName = Upload._getModelName(ModEmpNom);
                    const topLevelFolderName = `EMPRESAS (${stageName}) ${modelName}`;
                    const topLevelFolderId = await Upload._findOrCreateFolder(drive, topLevelFolderName, rootFolderId);
                    const companyFolderId = await Upload._findOrCreateFolder(drive, CrmEmpNom, topLevelFolderId);
                    const authFolderId = await Upload._findOrCreateFolder(drive, 'Autorizaciones', companyFolderId);
                    
                    let mimeType, fileExtension;
                    const fileSignature = TickComFac.toString('hex', 0, 4);
                    if (fileSignature.startsWith('ffd8')) { mimeType = 'image/jpeg'; fileExtension = 'jpg'; }
                    else if (fileSignature.startsWith('89504e47')) { mimeType = 'image/png'; fileExtension = 'png'; }
                    else if (fileSignature.startsWith('25504446')) { mimeType = 'application/pdf'; fileExtension = 'pdf'; }
                    else { console.error(`[Proceso 1]: Formato no reconocido para TickSec: ${TickSec}`); continue; }

                    const fileStream = Readable.from(TickComFac);
                    const fileMetadata = { name: `autorizacion_${TickSec}.${fileExtension}`, parents: [authFolderId] };
                    const media = { mimeType: mimeType, body: fileStream };
                    const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
                    const { id: fileId, webViewLink: fileUrl } = response.data;

                    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
                    await poolConnect.request()
                        .input('TickSec', sql.Int, TickSec)
                        .input('TickUrlGooDriv', sql.VarChar, fileUrl)
                        .query("UPDATE Ticket SET TickComFac = NULL, TickUrlGooDriv = @TickUrlGooDriv WHERE TickSec = @TickSec");
                    
                    results.autorizaciones.push({ ticketSec: TickSec, url: fileUrl });
                    console.log(`[Proceso 1]: Autorización ${TickSec} subida y actualizada.`);
                }

                // --- PROCESO 2: SUBIR ADJUNTOS (TickAdjFac) ---
                console.log('\n[Proceso 2]: Iniciando subida de Adjuntos...');
                // NOTA: Se asume que la columna de fecha se llama 'TickFec'. Ajústala si es necesario.
                const adjQueryResult = await poolConnect.request()
                    .query(`SELECT T.TickSec, T.TickAdjFac, E.CrmEmpNom, E.CrmEtapPro, ME.ModEmpNom
                          	FROM Ticket T
                          	JOIN CrmEmpresa E ON T.CrmEmpCod = E.CrmEmpCod
                          	JOIN ModelosEmpresa ME ON E.ModEmpSec = ME.ModEmpSec
                          	WHERE T.TickAdjFac IS NOT NULL AND T.TickFecCre >= '2025-09-01'`);
                console.log(`[Proceso 2]: Adjuntos encontrados: ${adjQueryResult.recordset.length}`);

                for (const ticket of adjQueryResult.recordset) {
                    const { TickSec, TickAdjFac, CrmEmpNom, CrmEtapPro, ModEmpNom } = ticket;
                    
                    // La lógica para encontrar/crear carpetas de primer nivel y empresa es la misma
                    const stageName = Upload._getStageName(CrmEtapPro);
                    const modelName = Upload._getModelName(ModEmpNom);
                    const topLevelFolderName = `EMPRESAS (${stageName}) ${modelName}`;
                    const topLevelFolderId = await Upload._findOrCreateFolder(drive, topLevelFolderName, rootFolderId);
                    const companyFolderId = await Upload._findOrCreateFolder(drive, CrmEmpNom, topLevelFolderId);
                    
                    // Se crea o busca la carpeta "Adjuntos"
                    const attachmentsFolderId = await Upload._findOrCreateFolder(drive, 'Adjuntos', companyFolderId);
                    
                    let mimeType, fileExtension;
                    const fileSignature = TickAdjFac.toString('hex', 0, 4);
                    if (fileSignature.startsWith('ffd8')) { mimeType = 'image/jpeg'; fileExtension = 'jpg'; }
                    else if (fileSignature.startsWith('89504e47')) { mimeType = 'image/png'; fileExtension = 'png'; }
                    else if (fileSignature.startsWith('25504446')) { mimeType = 'application/pdf'; fileExtension = 'pdf'; }
                    else { console.error(`[Proceso 2]: Formato no reconocido para Adjunto de TickSec: ${TickSec}`); continue; }

                    const fileStream = Readable.from(TickAdjFac);
                    const fileMetadata = { name: `Adjunto_${TickSec}.${fileExtension}`, parents: [attachmentsFolderId] };
                    const media = { mimeType: mimeType, body: fileStream };
                    const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
                    const { id: fileId, webViewLink: fileUrl } = response.data;

                    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
                    
                    // Se actualiza la nueva columna de URL y se limpia el blob del adjunto
                    await poolConnect.request()
                        .input('TickSec', sql.Int, TickSec)
                        .input('TickAdjUrlGooDriv', sql.VarChar, fileUrl)
                        .query("UPDATE Ticket SET TickAdjFac = NULL, TickAdjUrlGooDriv = @TickAdjUrlGooDriv WHERE TickSec = @TickSec");
                    
                    results.adjuntos.push({ ticketSec: TickSec, url: fileUrl });
                    console.log(`[Proceso 2]: Adjunto ${TickSec} subido y actualizado.`);
                }

                console.log('\n[UploadFile]: Proceso completado exitosamente.');
                res.status(200).json({ message: 'Procesos de subida finalizados.', results });

            } finally {
                poolConnect.close();
                console.log('[Database]: Conexión cerrada.');
            }
        } catch (error) {
            console.error('[Error General]:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Error al procesar la solicitud.' });
        }
    }
}