# Comunidad Sanantes

Repositorio curado de videos de El Podcast del Cáncer, preparado para Vercel.

## Qué hace

- Muestra reproductores incrustados; **no descarga ni almacena archivos de video o audio**. La base guarda metadatos, enlaces, usuarios, puntos, fuentes, artículos y aportes.
- Secciones independientes para El Podcast del Cáncer, selección de otros canales, directos, blog, comunidad y donaciones.
- Dashboard protegido por sesión y rol de administrador. Añade o pausa fuentes; sincroniza; edita títulos, categorías y descripciones; clasifica, publica u oculta; escribe artículos; consulta/exporta miembros; ajusta puntos; registra aportes; cambia textos, color, reglas y meta.
- Acceso sin contraseña por correo verificado, mediante Resend. Solo el correo configurado en `ADMIN_EMAIL` obtiene rol administrador. Los enlaces caducan en 15 minutos y son de un solo uso; las sesiones duran siete días.
- Puntos de bienvenida, invitaciones y difusión de artículos. Sistema de gamificación con niveles de comunidad (`Semilla`, `Voz`, `Compañero`, `Guardián`), insignias dinámicas (`Mecenas`, `Embajador`, `Lector`, `Pionero`) y Muro de Gratitud público con nombres protegidos.
- Contador de aportes confirmados en USD con meta editable y botón oficial a PayPal (`https://paypal.me/podcastcancer`). Asignación manual de aportes a miembros para otorgar puntos de Mecenas (+10 pts por cada $1 USD).
- Artículos de blog con descarga complementaria en PDF protegida por acción social (WhatsApp, Facebook, X).
- Vistas previas enriquecidas en redes sociales (`/v/:id` y `/b/:slug`) con tarjetas OpenGraph y Twitter Cards en alta resolución para Telegram, WhatsApp, Twitter y Facebook.
- Salvaguarda de gasto y disyuntor (`Budget Guard & Circuit Breaker`) en `lib/budget-guard.mjs` con fallback seguro para APIs de pago.
- Ver [CHANGELOG.md](file:///d:/Descargas%202/Antigravity/sananteshub/CHANGELOG.md) para el detalle completo de versiones y mejoras.

## Estado del catálogo inicial

Consultado el 20 de septiembre de 2026:

- Catálogo de 115 registros: 97 de Odysee y 18 de YouTube. Se reprocesaron 114 registros con Jev usando las nuevas señales; se conserva una edición manual.
- Ocho directos musicales de menos de una hora quedaron excluidos del catálogo público. Los casos ambiguos permanecen pendientes, sin forzar una clasificación.
- Los títulos y las miniaturas son reales y conservan la atribución de su plataforma. Los títulos son los del autor, no una validación médica de sus afirmaciones.
- Blog y selección de fuentes externas están vacíos, listos para contenido elegido por el administrador. No hay miembros, aportes ni métricas inventados.
- Las publicaciones futuras no se descargan: se importan sus metadatos.

## Clasificación y publicación automática

1. Se utilizan primero metadatos explícitos de la plataforma. En YouTube, `liveStreamingDetails` identifica emisiones actuales y pasadas, incluso cuando `liveBroadcastContent` ya dice `none`.
2. Jev recibe observaciones separadas: título musical y de relajación, descripción de emisiones o episodios, contexto específico de los canales del propietario y similitud de títulos con cinco directos cortados confirmados por el propietario en su captura. Se comprueba también si la URL de miniatura coincide exactamente con una referencia. No se analiza automáticamente el estilo visual de los píxeles; la observación visual de esos cinco ejemplos está atribuida al propietario.
3. La duración es una señal contextual, nunca una decisión: un directo cortado a los 15 segundos sigue siendo directo y un episodio editado puede superar 30 minutos. Jev elige video, live o review. Los cambios de evidencia invalidan la caché; los resultados idénticos ya procesados no bloquean los siguientes lotes.
4. La respuesta es una elección entre `video`, `live` y `review`, con probabilidades y confianza. Umbral inicial editable: 0. Se respeta directamente la opción de Jev; solo `review` se retiene, sin imponer un segundo filtro de confianza. El administrador puede elevar el umbral si lo desea.
5. Las clasificaciones aceptadas se publican automáticamente cuando `autoPublish=1` (valor inicial); los directos se muestran exclusivamente en Directos. El administrador puede elegir revisión manual de todo si lo desea.
6. Solo los indeterminados quedan para revisión humana. Una corrección manual no se sobrescribe en sincronizaciones posteriores.
7. Se conserva el resultado, modelo, tokens y huella del análisis para no volver a facturar una clasificación idéntica.

La integración usa POST https://api.typesafe.ai/v1/systemone, modelo jev-1.13.0. Los registros de respuestas y tokens están en lib/classifications.json. Las claves privadas no se incluyen en la descarga.

Después de la decisión de Jev, los directos musicales con duración conocida mayor de cero y menor de 3.600 segundos quedan ocultos por emisión interrumpida. Exactamente una hora sí cumple el mínimo. Se conserva un registro administrativo para deduplicar futuras sincronizaciones; no se descargan archivos multimedia. La API pública aplica también el filtro y el administrador no puede publicar esos registros sin corregir su clasificación. Una duración desconocida no prueba interrupción.

Referencia: https://docs.typesafe.ai/api y https://docs.typesafe.ai/models. La tarifa consultada es US$0,042 por millón de tokens de entrada, con salida gratuita. 10.000 videos × 1.000 tokens = US$0,42; incluye todos los tokens de reglas y metadatos, excluye hosting y otros servicios. El proveedor documenta mayor precisión en inglés; validar con una muestra del catálogo en español.

## Otras mejoras con Jev

La integración añade dos decisiones independientes en la misma llamada que clasifica un contenido nuevo:

- **Categoría temática:** bienestar emocional, música y relajación, respiración y meditación, entrevistas y testimonios, investigación y tratamientos, cuidados y vida cotidiana, comunidad y recursos u otros temas. Los filtros públicos se construyen con esas categorías.
- **Pertinencia editorial:** relacionado, claramente ajeno o incierto. Los contenidos claramente ajenos de fuentes externas vuelven a la bandeja del curador; no se eliminan. Una categoría médica identifica el tema, no acredita la veracidad de afirmaciones ni valida tratamientos.

Los 115 registros iniciales ya se organizaron con Jev. «Organizar temas con Jev», en Videos y directos, también organiza el catálogo existente por lotes. Para contenidos ya clasificados solicita solo las dos decisiones editoriales, sin volver a preguntar el formato. Los resultados se guardan en `media_labels` con la huella de los metadatos y el modelo; repetir la acción sin cambios no vuelve a consumir API. Las categorías modificadas manualmente quedan protegidas en `editorial_overrides`.

La sincronización automática procesa hasta 10 clasificaciones y 10 decisiones de organización por ejecución para respetar el tiempo de la función. Los botones del administrador procesan la cola restante. Las cuentas, sesiones, roles, puntos y pagos se gestionan mediante reglas deterministas de servidor.

## Plataformas

| Plataforma | Sincronización | Reproducción |
|---|---|---|
| Odysee | Implementada con `resolve` y `claim_search`, páginas de 50. Lectura real comprobada. | Embed oficial |
| YouTube | Implementada con Data API, clave propia y playlist de subidas. Recupera también metadatos de directos terminados. API autenticada pendiente de prueba. | Embed con dominio youtube-nocookie |
| Vimeo | Implementada para `vimeo.com/user12345` o usuario numérico; requiere token. Pendiente de prueba con cuenta. | Embed oficial; videos públicos |
| Dailymotion | Implementada para canales públicos; pendiente de prueba de sincronización real. | Embed oficial |
| Rumble | Alta manual por URL. No hay sincronizador automático implementado. | Embed si se facilita enlace `/embed/.../`; URL normal se abre en Rumble |

Todos tienen enlace para abrir en origen si el reproductor está restringido, el contenido fue retirado o la plataforma impide la inserción. Se evitan duplicados por plataforma/identificador. No se fusionan automáticamente las copias del mismo episodio alojadas en distintas plataformas.

## Ejecutar localmente

Requiere Node.js 24, sin dependencias npm externas.

```bash
cp .env.example .env
npm run dev
```

Abre http://localhost:3000. La base SQLite local se crea automáticamente y no debe subirse a Vercel.

Para probar el acceso sin mandar correos, configura `DEV_AUTH=1` y `ADMIN_EMAIL=tu-correo@example.com`. Esta opción solo funciona en localhost/127.0.0.1, nunca en Vercel. El formulario devuelve un enlace de prueba local y lo identifica expresamente como tal. No hay contraseña administrativa ni credencial universal incrustada.

```bash
npm test
npm run build
```

Las pruebas comprueban sesiones, enlace de acceso de un uso, control de rol, origen de solicitudes, duplicación de puntos, directos terminados, validación de URLs y el contrato/caché de Jev mediante una respuesta simulada. No certifican la precisión de Jev ni sustituyen pruebas contra las cuentas reales.

## Dominio Oficial (`sanantes.com`)

- **Dominio registrado:** `sanantes.com`
- **Registrador:** Hostinger
- **Vigencia:** 3 años (adquirido en septiembre de 2026, vencimiento en septiembre de 2029).
- **Direccionamiento DNS para Vercel:**
  - Registro A: `@` → `76.76.21.21`
  - Registro CNAME: `www` → `cname.vercel-dns.com`
- **Variable de entorno:** `APP_ORIGIN=https://sanantes.com`

## Publicar en Vercel

1. Crea una base libSQL en Turso. Obtén su URL y token. El código también permite sustituir este proveedor manteniendo el contrato de `lib/db.mjs`.
2. Configura las variables `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` localmente, en un `.env` privado. Ejecuta `npm run db:init` **una vez** contra esa base. Es idempotente: conserva datos existentes. No uses la base SQLite local como almacenamiento de producción.
3. Sube este directorio a un repositorio propio e impórtalo en Vercel. Framework: Other. Build command: `npm run build`. Output: `public`. Node: 24.x. La configuración ya declara `/api/index.js` y los rewrites.
4. Configura las variables de producción en Vercel:

| Variable | Uso |
|---|---|
| `APP_ORIGIN` | URL HTTPS exacta del sitio (`https://sanantes.com`), sin rutas |
| `TURSO_DATABASE_URL` | URL de la base persistente |
| `TURSO_AUTH_TOKEN` | Token privado de la base |
| `ADMIN_EMAIL` | Único correo autorizado inicialmente para administrar |
| `RESEND_API_KEY` | Envío del acceso por correo |
| `EMAIL_FROM` | Remitente de un dominio verificado en Resend |
| `YOUTUBE_API_KEY` | YouTube Data API v3 habilitada; sin restricción de referer de navegador |
| `TYPESAFE_API_KEY` | Credencial de Jev |
| `TYPESAFE_MODEL` | Opcional: `jev-1.13.0` |
| `CRON_SECRET` | Secreto aleatorio largo para la sincronización programada |
| `VIMEO_ACCESS_TOKEN` | Solo si conectas Vimeo |

5. Publica, entra con `ADMIN_EMAIL`, completa contacto/política de privacidad y enlace/meta de donaciones. Activa Jev en Ajustes y pulsa Clasificar con Jev para procesar el catálogo ya importado.
6. Comprueba reproducción de las plataformas, correo real, clasificación y sincronización antes de abrir el registro a la comunidad. El proyecto no ha sido desplegado todavía en tu cuenta de Vercel ni probado con Turso remoto.

Nunca pongas credenciales en el frontend ni en el chat. No configures `DEV_AUTH` ni `LOCAL_DATABASE_PATH` en Vercel.

## Programación, costos y límites

El cron incluido se ejecuta una vez al día a las 12:00 UTC y avanza una página de la fuente activa que lleve más tiempo sin sincronizarse. Con dos fuentes, cada una se visita aproximadamente cada dos días. El botón del administrador permite sincronizar cuando quieras. Para una cadencia mayor por canal, ajustar programación y cola según el plan elegido de Vercel; no se promete sincronización instantánea.

El catálogo público devuelve hasta 300 videos y el administrador hasta 1.000; para superar esos tamaños, añadir paginación de servidor antes de ampliar el catálogo. La selección por tipo y la separación público/administrador se validan en servidor. Es una primera versión funcional, no una plataforma de escala ilimitada.

Turso publica un plan gratuito; su continuidad y condiciones deben verificarse al abrir la cuenta: no se promete almacenamiento gratis perpetuo. Supabase publica pausa tras una semana de inactividad en su plan gratuito, por lo que no se usó como base inicial. Fuentes: https://turso.tech/pricing y https://supabase.com/pricing. Vercel puede exigir un plan acorde al uso comercial del proyecto; verificar las condiciones al desplegar.

Las publicaciones se incrustan bajo demanda. Las miniaturas se cargan desde sus servidores externos. La app utiliza una cookie HttpOnly/SameSite para sesión y `sessionStorage` únicamente para el código temporal de invitación, nunca como base de miembros o puntos.

## Verificación pendiente

La compilación y las pruebas de servidor pasan. La descarga del navegador de pruebas no estuvo disponible en este entorno, por lo que no se ha completado la revisión visual automatizada de escritorio y móvil. El HTML de vista previa permite revisar el diseño y navegar por el catálogo real y por el panel administrativo en modo de solo lectura; no ejecuta operaciones de servidor ni representa una sesión de administrador real. Antes del lanzamiento se deben verificar en navegador las conexiones reales y el diseño.

## Tareas Pendientes y Roadmap (Monetización Ética & Recursos)

- [ ] **Módulo de Tienda y Recomendaciones de la Comunidad:**
  - Crear una nueva sección en la plataforma (`#tienda` o `#recursos`) con catálogo visual de productos recomendados para el bienestar, suplementación y apoyo a pacientes y familias.
  - **Integración multicanal de ingresos:**
    1. **Droppi:** Enlace de productos físicos locales y kits de bienestar bajo modelo de dropshipping.
    2. **iHerb (Afiliados):** Suplementos coadyuvantes, fitoterapia y nutrición con enlace de afiliado personal.
    3. **Amazon (Afiliados):** Libros de referencia oncológica/emocional, arteterapia y accesorios de meditación/descanso.
  - **Panel de Administración:** Pestaña para añadir, pausar, editar precios y categorizar productos con su URL de afiliado.
  - **Transparencia Ética:** Aviso legal visible informando que las compras generan una pequeña comisión para sostener el proyecto sin costo adicional para el comprador, y que ningún suplemento sustituye el tratamiento médico.

