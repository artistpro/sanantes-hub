# Historial de Cambios y Mejoras (Changelog)

Todas las mejoras y actualizaciones técnicas de **Comunidad Sanantes**.

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
  - Hard-limit, Circuit Breaker y Fallback del Budget Guard.
- Verificación en entorno de producción desplegado en Vercel.
