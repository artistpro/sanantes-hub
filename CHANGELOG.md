# Historial de Cambios y Mejoras (Changelog)

Todas las mejoras y actualizaciones técnicas de **Comunidad Sanantes**.

---

## [2026-09-24] - Autenticación Híbrida (Google OAuth + Contraseña) y Google Analytics 4 (GA4)

### 🌟 Nuevas Funcionalidades

#### 1. Autenticación Híbrida Segura (Email + Contraseña + Google OAuth 2.0)
- **Acceso con 1 Clic (Sign In with Google):**
  - Integración nativa con Google Identity Services (`gsi/client`) y Google One-Tap.
  - Client ID oficial configurado: `556094809768-t183rn0i6c4k3mkrnj0et9irjphmfd3a.apps.googleusercontent.com`.
  - Endpoint `POST /api/auth/google`: Valida el `id_token` firmado por Google contra `https://oauth2.googleapis.com/tokeninfo`, crea o vincula la cuenta del usuario, asigna puntos de bienvenida y genera sesión HTTP-only segura.
- **Registro Directo e Inicio de Sesión con Contraseña:**
  - Endpoint `POST /api/auth/register`: Registro instantáneo con nombre, email, contraseña (mínimo 6 caracteres) y aceptación de política de privacidad.
  - Endpoint `POST /api/auth/login`: Validación timing-safe de credenciales.
  - **Auto-adopción de clave para Admin:** Si el administrador (`artistproco@gmail.com`) entra por primera vez con contraseña, el sistema encripta su clave y la fija sin requerir reseteo manual.
- **Criptografía Robusta Nivel Bancario:**
  - Uso de algoritmo estándar `scrypt` (`node:crypto` nativo de Node.js) con salt aleatorio de 16 bytes y clave derivada de 64 bytes.
  - Prevención de ataques de canal lateral (timing attacks) mediante `crypto.timingSafeEqual`.
- **Auto-Migración Transparente en Base de Datos (Turso / SQLite):**
  - Módulo `ensureAuthSchema()` en `api/index.js` que verifica y crea sobre la marcha las columnas `password_hash`, `password_salt`, `google_id` y el índice `users_google` sin requerir downtime ni migraciones manuales por CLI.
- **Interfaz de Usuario (Modal de Acceso):**
  - Selector con 3 pestañas: *Iniciar sesión*, *Registrarme* y *Enlace al correo* (fallback sin clave).
  - Selector dinámico de visibilidad de contraseña (icono 👁️ / 🔒).
  - Campo de configuración en Administración (`#admin` > Ajustes) para modificar el `Google Client ID` sin tocar código.

#### 2. Analítica Web Integral con Google Analytics 4 (GA4)
- **Medición Oficial:** ID de flujo web `G-JNXSFX7HF3` registrado para el dominio `sanantes.com`.
- **Inyección no-bloqueante:** Script `gtag.js` cargado de forma asíncrona en el `<head>` de `public/index.html`.
- **Rastreo Dinámico SPA (Single Page Application):** Hook en la función `route()` de `public/app.js` que dispara eventos `page_view` cada vez que el usuario navega entre las diferentes secciones (`#podcast`, `#explorar`, `#directos`, `#blog/:slug`, `#video/:id`, `#comunidad`, `#apoyar`, `#admin`).
- **Medición Mejorada:** Conteo en tiempo real de usuarios activos, sesiones, retención, fuentes de tráfico, países y reproducciones de contenido.

### 🛡️ Huellas de Auditoría y Despliegue en Producción
- **Commit `3ff4a16`:** Activación de Google OAuth Client ID por defecto en `api/index.js`.
- **Commit `8944613`:** Integración de Google Analytics GA4 (`G-JNXSFX7HF3`) en `public/index.html` y tracking dinámico de rutas en `public/app.js`.
- **Despliegues en Vercel:** Ambas versiones desplegadas y verificadas con estado HTTP 200 en `https://sanantes.com`.
- **Suite de Pruebas Automatizadas:** 13 pruebas unitarias e integración en verde (`npm test`, 100% pasando en ~1.0 s).

---

## [2026-09-22] - Gamificación, Donaciones USD PayPal, Social Previews y Budget Guard

### 🌟 Nuevas Funcionalidades

#### 1. Donaciones Internacionales en USD vía PayPal
- **Moneda estándar internacional:** Migración completa de pesos colombianos (COP) a dólares estadounidenses (USD) con meta por defecto de $500 USD.
- **Enlace oficial de aporte:** Integración directa con `https://paypal.me/podcastcancer`.
- **Registro administrativo de aportes:** Nuevo panel en Administración para registrar aportes confirmados y vincularlos opcionalmente a un miembro registrado de la comunidad.
- **Reconocimiento automático de Mecenas:** Al registrar un aporte asignado a un usuario, se le otorgan automáticamente +10 puntos de comunidad por cada $1 USD donado.

#### 2. Gamificación Integral, Insignias y Muro de Gratitud
- **Niveles de Comunidad:**
  - `🌱 Semilla de comunidad` (0 - 49 pts): Miembro recién incorporado.
  - `🗣️ Voz que acompaña` (50 - 199 pts): Miembro activo que comparte y participa.
  - `🤝 Compañero de camino` (200 - 499 pts): Gran difusor de contenidos y lecturas.
  - `🛡️ Guardián de la comunidad` (500+ pts): Pilar fundamental del proyecto.
- **Insignias Dinámicas:**
  - `💛 Mecenas`: Aporte voluntario confirmado en PayPal.
  - `📢 Embajador`: Invitó a 3 o más personas a la comunidad.
  - `📖 Lector`: Difundió investigaciones y lecturas del blog.
  - `🌱 Pionero`: Miembro fundador de la comunidad.
- **Muro de Gratitud (Leaderboard):**
  - Tabla pública en la sección "Mi comunidad" que destaca el top de miembros más activos.
  - Anonimización automática de nombres (ej. `Carlos R.`) para proteger la privacidad de los pacientes y familiares.
  - Indicador visual del puesto en el ranking (`🥇 1º`, `🥈 2º`, `🥉 3º`), nivel, insignias y puntuación.

#### 3. Casillero Social para Investigaciones y Descargas PDF
- **Material complementario en Blog:** Los artículos ahora admiten adjuntar un archivo descargable (PDF o documento de investigación).
- **Locker Social:** El documento permanece bloqueado hasta que el usuario comparta el artículo en WhatsApp, Facebook o X (Twitter).
- **Desbloqueo con recompensa:** Tras una cuenta regresiva de verificación de 15 segundos, el usuario desbloquea la descarga gratuita y suma +20 puntos de comunidad.

#### 4. Vistas Previas Enriquecidas con OpenGraph & Twitter Cards
- **Rutas dedicadas de vista previa:**
  - Videos: `/v/:id` (con soporte para referidos: `/v/:id?ref=...`).
  - Blog: `/b/:slug`.
- **Soporte completo de tarjetas sociales:** Los rastreadores de **Telegram, WhatsApp, X (Twitter) y Facebook** leen etiquetas `og:image`, `og:title`, `og:description` y `twitter:card: summary_large_image`.
- **Miniaturas limpias de YouTube:** Uso de la URL canónica `https://i.ytimg.com/vi/${external_id}/hqdefault.jpg`, garantizando que la imagen coincida exactamente con el video compartido y no expire ni dependa de tokens de sesión.
- **Sin interferencia de redirección:** Se eliminó la etiqueta `<meta http-equiv="refresh">` para evitar que los scrapers de redes sociales salten a la raíz del sitio.
- **Redirección instantánea para humanos:** Cuando un usuario hace clic en el enlace, un script en cliente lo redirige en 0 ms al reproductor dentro de la SPA preservando su código de referido.

#### 5. Salvaguarda de Presupuesto y Disyuntor (Budget Guard & Circuit Breaker)
- **Control de gasto en APIs de pago:** Módulo `lib/budget-guard.mjs` que protege el consumo de la API de clasificación (TypeSafe Jev).
- **Hard-limit diario:** Tope configurable por `.env` (ej. 50 llamadas o $0.10 USD diarios) que aborta peticiones antes de emitirlas a la red.
- **Circuit Breaker anti-bucles:** Detiene la ejecución tras 3 fallos consecutivos de la API externa.
- **Fallback resiliente no-bloqueante:** Si la API externa falla o se alcanza el límite de gasto, conmuta de forma segura a estado de revisión manual (`review`) sin interrumpir la sincronización de contenidos.
- **Ledger local:** Registro acumulado en `.budget_ledger.json`.

#### 6. Adquisición y Configuración de Dominio Oficial (sanantes.com)
- **Registro de Dominio:** Adquisición de `sanantes.com` en Hostinger con periodo contratado de 3 años (vigencia hasta septiembre de 2029).
- **Enrutamiento DNS para Vercel:** Documentación de registros A (`76.76.21.21`) y CNAME (`cname.vercel-dns.com`) para apuntamiento con SSL automático.
- **Preparación de Entorno:** Parámetro `APP_ORIGIN=https://sanantes.com` para URLs canónicas y enlaces de invitación.

---

### 🧪 Pruebas y Cobertura
- 11 pruebas unitarias automatizadas (`npm test`):
  - Autenticación segura de un solo uso por correo verificado.
  - Control de acceso y roles de administración.
  - Prevención de granjas de puntos por referidos repetidos.
  - Separación de directos vs videos en el catálogo.
  - Clasificación de formatos y temas con Jev.
  - Asignación de puntos y nivel de Mecenas por donaciones.
  - Vistas previas OpenGraph de videos y blog en `/v/:id` y `/b/:slug`.
  - Verificación en entorno de producción desplegado en Vercel.

---

## 📌 Tareas Pendientes (Backlog de Próxima Fase)

### Monetización Ética & Tienda de Recursos
- **Objetivo:** Generar fuentes sostenibles de ingresos para la producción de contenidos mediante recomendaciones de productos útiles y honestos.
- **Canales a Integrar:**
  1. **Droppi:** Enlace a productos físicos locales y kits terapéuticos (dropshipping).
  2. **iHerb (Programa de Afiliados):** Suplementación coadyuvante, fitoterapia e higiene limpia.
  3. **Amazon (Programa de Afiliados):** Libros de referencia (Dr. Bernie Siegel, nutrición, arteterapia) y accesorios de descanso/meditación.
- **Requerimientos de Sistema:**
  - Nueva sección pública `#tienda` o `#recursos`.
  - Pestaña administrativa para registrar productos, categorías, imágenes y enlaces de afiliado.
  - Avisos de transparencia ética y descargo de responsabilidad médica.

