import { google } from 'googleapis';
import { Readable } from 'stream';
import { pool, sql } from '../db/connect.js';
import 'dotenv/config';

export default class Upload {

    static getOAuth2Client() {
        const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
        const oAuth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );
        return oAuth2Client;
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

    static async _findAndDeleteExistingFile(drive, parentId, baseFileName) {
        try {
            const query = `'${parentId}' in parents and name contains '${baseFileName}' and trashed = false`;
            const res = await drive.files.list({
                q: query,
                fields: 'files(id, name)',
            });

            if (res.data.files.length > 0) {
                console.log(`[Reemplazo]: Se encontraron ${res.data.files.length} archivos existentes para ${baseFileName}. Eliminando...`);
                for (const file of res.data.files) {
                    await drive.files.delete({ fileId: file.id });
                    console.log(`[Reemplazo]: Archivo eliminado: ${file.name} (ID: ${file.id})`);
                }
            }
        } catch (error) {
            console.error(`[Reemplazo Error]: No se pudo eliminar el archivo existente para ${baseFileName}.`, error);
        }
    }

    static async _uploadFileLogic(config) {
        const { drive, poolConnect, rootFolderId, blobField, urlField, folderName, fileNamePrefix, query, resultsList } = config;

        console.log(`\n[Proceso: ${folderName}]: Iniciando subida...`);
        const queryResult = await poolConnect.request().query(query);
        console.log(`[Proceso: ${folderName}]: Archivos encontrados: ${queryResult.recordset.length}`);

        for (const record of queryResult.recordset) {
            const { TickSec, CrmEmpNom, CrmEtapPro, ModEmpNom } = record;
            const blobData = record[blobField];

            if (!blobData) continue;

            const stageName = Upload._getStageName(CrmEtapPro);
            const modelName = Upload._getModelName(ModEmpNom);
            const topLevelFolderName = `EMPRESAS (${stageName}) ${modelName}`;
            const topLevelFolderId = await Upload._findOrCreateFolder(drive, topLevelFolderName, rootFolderId);
            const companyFolderId = await Upload._findOrCreateFolder(drive, CrmEmpNom, topLevelFolderId);
            const targetFolderId = await Upload._findOrCreateFolder(drive, folderName, companyFolderId);

            const fileSignature = blobData.toString('hex', 0, 4);
            let mimeType, fileExtension;
            if (fileSignature.startsWith('ffd8')) { mimeType = 'image/jpeg'; fileExtension = 'jpg'; }
            else if (fileSignature.startsWith('89504e47')) { mimeType = 'image/png'; fileExtension = 'png'; }
            else if (fileSignature.startsWith('25504446')) { mimeType = 'application/pdf'; fileExtension = 'pdf'; }
            else { console.error(`[Proceso: ${folderName}]: Formato no reconocido para TickSec: ${TickSec}`); continue; }

            const baseFileName = `${fileNamePrefix}${TickSec}`;
            const finalFileName = `${baseFileName}.${fileExtension}`;
            
            await Upload._findAndDeleteExistingFile(drive, targetFolderId, baseFileName);

            const fileStream = Readable.from(blobData);
            const fileMetadata = { name: finalFileName, parents: [targetFolderId] };
            const media = { mimeType: mimeType, body: fileStream };
            const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
            const { id: fileId, webViewLink: fileUrl } = response.data;

            await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

            const updateQuery = `UPDATE Ticket SET ${blobField} = NULL, ${urlField} = @Url WHERE TickSec = @TickSec`;
            await poolConnect.request()
                .input('TickSec', sql.Int, TickSec)
                .input('Url', sql.VarChar, fileUrl)
                .query(updateQuery);
            
            resultsList.push({ ticketSec: TickSec, url: fileUrl });
            console.log(`[Proceso: ${folderName}]: Archivo ${TickSec} subido/reemplazado y DB actualizada.`);
        }
    }

    static _getStateName(statusChar) {
        const states = {
            A: 'Abierto', C: 'Cerrado', R: 'Revision', P: 'PendienteCliente',
            Z: 'ActualizarPruebas', X: 'ActualizarPrincipal', S: 'SinClasificar',
            E: 'Entregado', D: 'EnDesarrollo', M: 'PendienteCorreccion',
            F: 'PruebaClientes', G: 'PendienteCorreccionesCliente',
            J: 'PorEntregar', T: 'Cotizar', k: 'CorreccionPrincipal'
        };
        return states[statusChar] || 'Indefinido';
    }

    static async _uploadActivityFileLogic(config) {
        const { drive, poolConnect, rootFolderId, query } = config;

        console.log(`\n[Proceso: Adjuntos Actividad]: Iniciando subida...`);
        const queryResult = await poolConnect.request().query(query);
        console.log(`[Proceso: Adjuntos Actividad]: Archivos encontrados: ${queryResult.recordset.length}`);

        for (const record of queryResult.recordset) {
            const { 
                TickSec, TickActLinSec, TickBitEstSec, TickBitEstNue, TickBitFecHorCre, 
                TickActAdj, CrmEmpNom, CrmEtapPro, ModEmpNom 
            } = record;

            if (!TickActAdj) continue;

            const stageName = Upload._getStageName(CrmEtapPro);
            const modelName = Upload._getModelName(ModEmpNom);
            const topLevelFolderName = `EMPRESAS (${stageName}) ${modelName}`;
            const topLevelFolderId = await Upload._findOrCreateFolder(drive, topLevelFolderName, rootFolderId);
            const companyFolderId = await Upload._findOrCreateFolder(drive, CrmEmpNom, topLevelFolderId);
            const attachmentsFolderId = await Upload._findOrCreateFolder(drive, 'Adjuntos', companyFolderId);
            const activityAttachmentsFolderId = await Upload._findOrCreateFolder(drive, 'Adjuntos Actividad', attachmentsFolderId);

            const fileSignature = TickActAdj.toString('hex', 0, 4);
            let mimeType, fileExtension;
            if (fileSignature.startsWith('ffd8')) { mimeType = 'image/jpeg'; fileExtension = 'jpg'; }
            else if (fileSignature.startsWith('89504e47')) { mimeType = 'image/png'; fileExtension = 'png'; }
            else if (fileSignature.startsWith('25504446')) { mimeType = 'application/pdf'; fileExtension = 'pdf'; }
            else { console.error(`[Adjuntos Actividad]: Formato no reconocido para TickSec: ${TickSec}`); continue; }

            const stateName = Upload._getStateName(TickBitEstNue);
            const timestamp = new Date(TickBitFecHorCre).toISOString().slice(0, 16).replace('T', '-').replace(':', 'h') + 'm';
            const finalFileName = `adjunto_${stateName}_${timestamp}_${TickSec}.${fileExtension}`;
            
            const fileStream = Readable.from(TickActAdj);
            const fileMetadata = { name: finalFileName, parents: [activityAttachmentsFolderId] };
            const media = { mimeType: mimeType, body: fileStream };
            const response = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id, webViewLink' });
            const { id: fileId, webViewLink: fileUrl } = response.data;

            await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });

            const updateQuery = `
                UPDATE TicketActividadNewBisEst 
                SET TickActAdj = NULL, TickActAdjBitDriv = @Url 
                WHERE TickSec = @TickSec AND TickActLinSec = @TickActLinSec AND TickBitEstSec = @TickBitEstSec
            `;
            await poolConnect.request()
                .input('Url', sql.VarChar, fileUrl)
                .input('TickSec', sql.Int, TickSec)
                .input('TickActLinSec', sql.Int, TickActLinSec)
                .input('TickBitEstSec', sql.Int, TickBitEstSec)
                .query(updateQuery);
            
            console.log(`[Adjuntos Actividad]: Archivo para TickSec ${TickSec} subido y DB actualizada.`);
        }
    }

    static async uploadFile(req, res) {
        try {
            const { esComprobante, esAdjunto, esCotizacion, esAdjuntoActividad } = req.params;
            console.log('[UploadFile]: Inicio del proceso de subida con parámetros:', { esComprobante, esAdjunto, esCotizacion, esAdjuntoActividad });
            
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(today.getDate() - 1);
            const yesterdayDateString = yesterday.toISOString().split('T')[0];

            console.log(`[Filtro de Fecha]: Procesando archivos desde ${yesterdayDateString} en adelante.`);
            
            const oAuth2Client = Upload.getOAuth2Client();
            oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
            
            const drive = await Upload.getDriveService(oAuth2Client);
            const rootFolderId = process.env.GOOGLE_FOLDER_ID;
            const poolConnect = await pool.connect();
            
            const results = { autorizaciones: [], adjuntos: [], cotizaciones: [], adjuntos_actividad: [] };

            try {
                const baseQuery = `
                    SELECT T.TickSec, T.TickComFac, T.TickAdjFac, T.TickAdjCoti, E.CrmEmpNom, E.CrmEtapPro, ME.ModEmpNom, T.TickFecCre
                    FROM Ticket T
                    JOIN CrmEmpresa E ON T.CrmEmpCod = E.CrmEmpCod
                    JOIN ModelosEmpresa ME ON E.ModEmpSec = ME.ModEmpSec
                `;

                if (esComprobante === 'conComprobante') {
                    await Upload._uploadFileLogic({
                        drive, poolConnect, rootFolderId,
                        blobField: 'TickComFac', urlField: 'TickUrlGooDriv', folderName: 'Autorizaciones',
                        fileNamePrefix: 'autorizacion_', resultsList: results.autorizaciones,
                        query: `${baseQuery} WHERE T.TickComFac IS NOT NULL AND T.TickFecCre >= '${yesterdayDateString}'`,
                    });
                }

                if (esAdjunto === 'conAdjunto') {
                    await Upload._uploadFileLogic({
                        drive, poolConnect, rootFolderId,
                        blobField: 'TickAdjFac', urlField: 'TickAdjUrlGooDriv', folderName: 'Adjuntos',
                        fileNamePrefix: 'Adjunto_', resultsList: results.adjuntos,
                        query: `${baseQuery} WHERE T.TickAdjFac IS NOT NULL AND T.TickFecCre >= '${yesterdayDateString}'`,
                    });
                }

                if (esCotizacion === 'conCotizacion') {
                    await Upload._uploadFileLogic({
                        drive, poolConnect, rootFolderId,
                        blobField: 'TickAdjCoti', urlField: 'TickCotUrlGooDriv', folderName: 'Cotizaciones',
                        fileNamePrefix: 'cotizacion_', resultsList: results.cotizaciones,
                        query: `${baseQuery} WHERE T.TickAdjCoti IS NOT NULL AND T.TickFecCre >= '${yesterdayDateString}'`,
                    });
                }

                if (esAdjuntoActividad === 'conAdjuntoActividad') {
                    const activityQuery = `
                        SELECT 
                            T.TickSec, TA.TickActLinSec, TA.TickBitEstSec, TA.TickBitEstNue,
                            TA.TickBitFecHorCre, TA.TickActAdj, E.CrmEmpNom, E.CrmEtapPro, ME.ModEmpNom
                        FROM TicketActividadNewBisEst TA
                        JOIN Ticket T ON TA.TickSec = T.TickSec
                        JOIN CrmEmpresa E ON T.CrmEmpCod = E.CrmEmpCod
                        JOIN ModelosEmpresa ME ON E.ModEmpSec = ME.ModEmpSec
                        WHERE TA.TickActAdj IS NOT NULL 
                        AND TA.TickBitFecHorCre >= '${yesterdayDateString}'
                    `;
                    await Upload._uploadActivityFileLogic({
                        drive, poolConnect, rootFolderId,
                        query: activityQuery
                    });
                }

                console.log('\n[UploadFile]: Proceso completado exitosamente.');
                res.status(200).json({ message: 'Procesos de subida finalizados.', results });

            } finally {
                if (poolConnect && poolConnect.connected) {
                    poolConnect.close();
                    console.log('[Database]: Conexión cerrada.');
                }
            }
        } catch (error) {
            console.error('[Error General]:', error.response ? error.response.data : error.message, error.stack);
            res.status(500).json({ error: 'Error al procesar la solicitud.' });
        }
    }
}