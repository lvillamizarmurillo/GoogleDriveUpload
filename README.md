# Sistema de Subida de Comprobantes a Google Drive

Este sistema está diseñado para subir comprobantes de pago a Google Drive, organizándolos en carpetas específicas según la empresa y el número de ticket. Utiliza Node.js, la API de Google Drive y una base de datos para gestionar los datos de los tickets y las empresas.

## Características
- **Autenticación OAuth2**: Configuración segura para interactuar con la API de Google Drive.
- **Organización en Google Drive**: Los archivos se suben a carpetas organizadas por empresa y número de ticket.
- **Soporte para múltiples formatos**: Compatible con archivos PDF, PNG y JPEG.
- **Actualización de base de datos**: Los registros se actualizan automáticamente después de subir los archivos.

## Requisitos Previos
1. **Node.js**: Asegúrate de tener Node.js instalado en tu sistema.
2. **Google Cloud Console**: Configura un proyecto en Google Cloud y habilita la API de Google Drive.
3. **Credenciales OAuth2**: Descarga el archivo JSON de credenciales y configura las variables de entorno.
4. **Base de Datos**: Configura la base de datos con las tablas necesarias (`Ticket` y `CrmEmpresa`).

## Instalación
1. Clona este repositorio:
   ```bash
   git clone <URL_DEL_REPOSITORIO>
   ```
2. Navega al directorio del proyecto:
   ```bash
   cd ApiNode
   ```
3. Instala las dependencias:
   ```bash
   npm install
   ```
4. Configura las variables de entorno:
   - Crea un archivo `.env` en la raíz del proyecto.
   - Agrega las siguientes variables:
     ```env
     GOOGLE_CLIENT_ID=<tu_client_id>
     GOOGLE_CLIENT_SECRET=<tu_client_secret>
     GOOGLE_REDIRECT_URI=<tu_redirect_uri>
     GOOGLE_OAUTH_TOKEN=<tu_token_oauth>
     GOOGLE_FOLDER_ID=<id_de_la_carpeta_principal>
     DB_CONNECTION_STRING=<cadena_de_conexión_a_la_base_de_datos>
     ```
5. Ejecuta el sistema:
   ```bash
   npm start
   ```

## Uso
1. **Autenticación**:
   - Si no tienes un token OAuth, el sistema generará una URL de autorización.
   - Visita la URL, autoriza la aplicación y obtén el código de autorización.
   - Usa el código para generar un token y guárdalo en el archivo `.env`.

2. **Subida de Archivos**:
   - El sistema procesará los registros de la base de datos y subirá los archivos a Google Drive.
   - Los archivos se organizarán en carpetas según la empresa y el número de ticket.

3. **Actualización de Base de Datos**:
   - Después de subir un archivo, el sistema actualizará el registro correspondiente en la base de datos.

## Estructura del Proyecto
- `app.js`: Archivo principal del sistema.
- `Routes/upload-comprobante.js`: Define las rutas para la subida de comprobantes.
- `Services/upload.js`: Lógica principal para interactuar con Google Drive y la base de datos.
- `db/connect.js`: Configuración de la conexión a la base de datos.
- `uploads/`: Carpeta temporal para almacenar archivos antes de subirlos (si es necesario).

## Tecnologías Utilizadas
- **Node.js**: Plataforma de desarrollo.
- **Google Drive API**: Para la gestión de archivos en la nube.
- **MSSQL**: Base de datos para almacenar los registros.
- **dotenv**: Gestión de variables de entorno.

## Contribuciones
Si deseas contribuir a este proyecto, por favor crea un fork del repositorio, realiza tus cambios y envía un pull request.

## Licencia
Este proyecto está bajo la licencia MIT. Puedes usarlo, modificarlo y distribuirlo libremente.

---

¡Gracias por usar este sistema! Si tienes preguntas o problemas, no dudes en abrir un issue en el repositorio.