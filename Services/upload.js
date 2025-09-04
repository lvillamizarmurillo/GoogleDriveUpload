import { google } from 'googleapis';
import { Readable } from 'stream';
import { pool, sql } from '../db/connect.js';
import dotenv from 'dotenv';

dotenv.config();

export default class Upload {
    static getOAuth2Client() {
        const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

        const oAuth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI
        );

        console.log('[Google OAuth]: Cliente OAuth configurado.');
        return oAuth2Client;
    }

    static generateAuthUrl() {
        const oAuth2Client = this.getOAuth2Client();
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: ['https://www.googleapis.com/auth/drive'],
        });
        console.log('[Google OAuth]: URL de autorización generada:', authUrl);
        return authUrl;
    }

    static async getTokenFromCode(code) {
        const oAuth2Client = this.getOAuth2Client();
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);
            console.log('[Google OAuth]: Token generado con éxito:', tokens);
            return tokens;
        } catch (error) {
            console.error('[Google OAuth Error]: Error al generar el token:', error);
            throw new Error('Error al generar el token.');
        }
    }

    static async getDriveService(oAuth2Client) {
        const drive = google.drive({ version: 'v3', auth: oAuth2Client });
        console.log('[Google Drive]: Servicio de Google Drive configurado.');
        return drive;
    }

    static async uploadFile(req, res) {
        try {
            console.log('[UploadFile]: Inicio del proceso de subida.');

            // Asegurarse de que el contexto de `this` sea correcto
            const oAuth2Client = Upload.getOAuth2Client();

            // Verificar si GOOGLE_OAUTH_TOKEN está definido
            const tokenEnv = process.env.GOOGLE_OAUTH_TOKEN;
            if (!tokenEnv) {
                const authUrl = Upload.generateAuthUrl();
                console.log('[Google OAuth]: Por favor, autoriza la aplicación visitando esta URL:', authUrl);
                return res.status(400).json({
                    error: 'Falta el token de OAuth. Autoriza la aplicación visitando la URL proporcionada.',
                    authUrl,
                });
            }

            // Usar el token directamente como string
            const token = { access_token: tokenEnv };
            oAuth2Client.setCredentials(token);
            console.log('[Google OAuth]: Token configurado correctamente.');

            const drive = await Upload.getDriveService(oAuth2Client);

            // ID de la carpeta en la unidad personal
            const parentFolderId = process.env.GOOGLE_FOLDER_ID;

            // Conexión a la base de datos
            console.log('[Database]: Conectando a la base de datos.');
            const poolConnect = await pool.connect();
            try {
                const queryResult = await poolConnect.request()
                    .query(`SELECT T.TickSec, T.TickComFac, T.CrmEmpCod, E.CrmEmpNom
                           FROM Ticket T
                           JOIN CrmEmpresa E ON T.CrmEmpCod = E.CrmEmpCod
                           WHERE T.TickComFac IS NOT NULL`);

                console.log(`[Database]: Registros obtenidos: ${queryResult.recordset.length}`);
                const tickets = queryResult.recordset;

                const urls = [];

                for (const ticket of tickets) {
                    const { TickSec, TickComFac, CrmEmpNom } = ticket;
                    console.log(`[Ticket]: Procesando TickSec: ${TickSec}, Empresa: ${CrmEmpNom}`);

                    // Verificar o crear carpeta de la empresa
                    let companyFolderId;
                    const companyFolder = await drive.files.list({
                        q: `name = '${CrmEmpNom}' and mimeType = 'application/vnd.google-apps.folder' and '${parentFolderId}' in parents`,
                        fields: 'files(id, name)',
                    });

                    if (companyFolder.data.files.length > 0) {
                        companyFolderId = companyFolder.data.files[0].id;
                        console.log(`[Google Drive]: Carpeta de empresa encontrada: ${CrmEmpNom}`);
                    } else {
                        const newCompanyFolder = await drive.files.create({
                            resource: {
                                name: CrmEmpNom,
                                mimeType: 'application/vnd.google-apps.folder',
                                parents: [parentFolderId],
                            },
                            fields: 'id',
                        });
                        companyFolderId = newCompanyFolder.data.id;
                        console.log(`[Google Drive]: Carpeta de empresa creada: ${CrmEmpNom}`);
                    }

                    // Verificar o crear carpeta del ticket
                    let ticketFolderId;
                    const ticketFolder = await drive.files.list({
                        q: `name = '${TickSec}' and mimeType = 'application/vnd.google-apps.folder' and '${companyFolderId}' in parents`,
                        fields: 'files(id, name)',
                    });

                    if (ticketFolder.data.files.length > 0) {
                        ticketFolderId = ticketFolder.data.files[0].id;
                        console.log(`[Google Drive]: Carpeta de ticket encontrada: ${TickSec}`);
                    } else {
                        const newTicketFolder = await drive.files.create({
                            resource: {
                                name: TickSec.toString(),
                                mimeType: 'application/vnd.google-apps.folder',
                                parents: [companyFolderId],
                            },
                            fields: 'id',
                        });
                        ticketFolderId = newTicketFolder.data.id;
                        console.log(`[Google Drive]: Carpeta de ticket creada: ${TickSec}`);
                    }

                    // Determinar el tipo MIME del archivo basado en el contenido
                    let mimeType;
                    const fileSignature = TickComFac.toString('hex', 0, 8);

                    if (fileSignature.startsWith('ffd8')) {
                        mimeType = 'image/jpeg';
                    } else if (fileSignature.startsWith('89504e47')) {
                        mimeType = 'image/png';
                    } else if (fileSignature.startsWith('25504446')) {
                        mimeType = 'application/pdf';
                    } else {
                        console.error(`[Ticket]: Formato de archivo no reconocido para TickSec: ${TickSec}`);
                        continue; // Saltar este archivo si el formato no es reconocido
                    }

                    // Convertir el Buffer en un flujo
                    const fileStream = Readable.from(TickComFac);

                    // Subir archivo a Google Drive con el formato correcto
                    const fileMetadata = {
                        name: `ComprobanteDePago_${TickSec}.${mimeType.split('/')[1]}`,
                        parents: [ticketFolderId],
                    };

                    const media = {
                        mimeType: mimeType,
                        body: fileStream,
                    };

                    const response = await drive.files.create({
                        resource: fileMetadata,
                        media: media,
                        fields: 'id, webViewLink',
                    });

                    const fileId = response.data.id;
                    const fileUrl = response.data.webViewLink;
                    console.log(`[Google Drive]: Archivo subido con ID: ${fileId}, URL: ${fileUrl}`);

                    // Hacer público el archivo
                    await drive.permissions.create({
                        fileId: fileId,
                        requestBody: {
                            role: 'reader',
                            type: 'anyone',
                        },
                    });
                    console.log(`[Google Drive]: Permisos públicos asignados al archivo con ID: ${fileId}`);

                    // Actualizar la base de datos
                    await poolConnect.request()
                        .input('TickSec', sql.Int, TickSec)
                        .input('TickUrlGooDriv', sql.VarChar, fileUrl)
                        .query("UPDATE Ticket SET TickComFac = NULL, TickUrlGooDriv = @TickUrlGooDriv WHERE TickSec = @TickSec");
                    console.log(`[Database]: TickSec ${TickSec} actualizado en la base de datos.`);

                    urls.push({ ticketSec: TickSec, url: fileUrl });
                }

                console.log('[UploadFile]: Proceso completado exitosamente.');
                res.status(200).json({ message: 'Archivos subidos y base de datos actualizada correctamente.', urls });
            } finally {
                poolConnect.close();
                console.log('[Database]: Conexión cerrada.');
            }
        } catch (error) {
            console.error('[Error]:', error);
            res.status(500).json({ error: 'Error al procesar los tickets.' });
        }
    }
}