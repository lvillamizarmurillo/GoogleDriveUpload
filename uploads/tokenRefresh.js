// Archivo: getRefreshToken.js
import { google } from 'googleapis';
import readline from 'readline';
import dotenv from 'dotenv';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

// 1. Configurar el cliente OAuth2 con las credenciales de tu proyecto
const oAuth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
);

// 2. Generar la URL de autorización
const authUrl = oAuth2Client.generateAuthUrl({
    // 'offline' es crucial para obtener el refresh_token
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    // 'consent' fuerza a que siempre aparezca la pantalla de permisos,
    // asegurando que se emita un nuevo refresh_token.
    prompt: 'consent'
});

console.log('Autoriza esta aplicación visitando la siguiente URL:\n');
console.log(authUrl);

// 3. Preparar la interfaz para leer la respuesta del usuario desde la consola
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

// 4. Pedir al usuario el código de autorización
rl.question('\nIngresa el código desde la URL de redirección aquí: ', async (code) => {
    rl.close();
    try {
        // 5. Intercambiar el código de autorización por los tokens
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);

        console.log('\nTokens obtenidos con éxito:');
        console.log(tokens);

        // 6. Mostrar el refresh_token para que el usuario lo copie
        if (tokens.refresh_token) {
            console.log('\n✅ ¡Éxito! Copia este Refresh Token y pégalo en tu archivo .env como GOOGLE_REFRESH_TOKEN:');
            console.log(`\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
        } else {
            console.log('\n❌ No se recibió un refresh_token. Asegúrate de que tu aplicación esté en "Producción" y que no hayas revocado los permisos previamente.');
        }

    } catch (error) {
        console.error('Error al obtener los tokens:', error.response ? error.response.data : error.message);
    }
});