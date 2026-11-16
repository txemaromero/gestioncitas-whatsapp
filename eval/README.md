# Evaluación de los prompts del bot (`eval/`)

Scripts en Python que reproducen la metodología de evaluación de referencia sobre las dos llamadas a LLM que hace el bot de WhatsApp de **FisioDemo** (clínica de fisioterapia en Alicante):

| Evaluación | Qué mide | Resultado de referencia | Objetivo |
|---|---|---|---|
| `eval_intent.py` | Clasificación de intención `CITA` / `FAQ` (accuracy estricta) | **99,06 %** | ≥ 99 % |
| `eval_faq.py` | Calidad de las respuestas FAQ con Ragas: `answer_relevancy` y `answer_correctness` | **0,75** / **0,77** | ≥ 0,75 cada una |

Los scripts usan **exactamente los mismos prompts que producción** (se leen de los ficheros del monorepo, no hay copias):

- `apps/bot/src/prompts/intent.txt` → detección de intención.
- `packages/db/prisma/seed-data/fisiodemo-faq.txt` + `apps/bot/src/prompts/faq-guard.txt` → respuesta a preguntas frecuentes. `fisiodemo-faq.txt` es el texto que genera el bot con la información de FisioDemo (`seed-data/fisiodemo.ts`): se regenera con `pnpm --filter @clinicai/db faq:fisiodemo` y un test comprueba que está al día.

Las rutas se resuelven respecto a la ubicación del script (la raíz del repo es la carpeta padre de `eval/`), así que se pueden ejecutar desde cualquier directorio.

## Qué reproduce cada script

**Intención (`eval_intent.py`)**

- Un único mensaje `user` con el contenido de `intent.txt`, sustituyendo `{sector}` por `clínica de fisioterapia` y `{mensaje}` por el mensaje del cliente. `temperature = 0`.
- Normalización idéntica al bot: `strip`, se quitan comillas/puntuación alrededor, mayúsculas; si el resultado no es exactamente `CITA` o `FAQ` se toma `FAQ`.
- Calcula accuracy estricta, matriz de confusión, precisión/recall por clase y lista las filas mal clasificadas. Los errores de API (tras los reintentos) cuentan como fallo.

**FAQ (`eval_faq.py`)**

- Genera la respuesta con la llamada de producción: `system` = `fisiodemo-faq.txt` + `"\n\n"` + `faq-guard.txt`, `user` = la pregunta, `temperature = 0.3`.
- Evalúa con [Ragas](https://docs.ragas.io/) las métricas `answer_relevancy` (pregunta ↔ respuesta) y `answer_correctness` (respuesta ↔ respuesta de referencia del dataset). Se informa la media de cada métrica.
- Usa la API actual de Ragas 0.4 (`ragas.metrics.collections.AnswerRelevancy` / `AnswerCorrectness`, con `llm_factory` y `embedding_factory` sobre un cliente `AsyncOpenAI`), no la API heredada `ragas.metrics.answer_relevancy`, que está marcada como obsoleta. Se usan los parámetros por defecto de Ragas (`strictness = 3` en relevancy; pesos 0,75 factualidad / 0,25 similitud en correctness).
- La telemetría de Ragas se desactiva por defecto (`RAGAS_DO_NOT_TRACK=true`, salvo que la definas tú).

## Datasets (`eval/data/`)

| Fichero | Filas | Columnas | Contenido |
|---|---|---|---|
| `intent.csv` | 100 (50 `CITA` / 50 `FAQ`) | `question,ground_truth` | Mensajes de WhatsApp realistas (informales, con erratas, sin tildes, de distinta longitud) e incluye los casos difíciles de las reglas del prompt: confirmar una cita (`FAQ`), «¿cómo cancelo una cita?» (`FAQ`), «no podré ir, ¿puedo cambiarla?» (`CITA`), «cancelar mi cita del jueves» (`CITA`), «necesito / busco / sería para…» (`CITA`), huecos y profesionales (`CITA`), saludos y despedidas (`FAQ`), dudas de salud sin intención de reservar (`FAQ`) y mensajes ambiguos (`FAQ`). |
| `faq.csv` | 30 | `question,ground_truth` | Preguntas frecuentes de FisioDemo con la respuesta esperada en una frase, coherente con los datos del prompt (dirección, teléfono 965 000 000, horario, pagos, aseguradoras, parking, servicios, profesionales, urgencias, sin cita previa y reservas). |

Los CSV están en UTF-8 y con las preguntas entre comillas; si añades filas, mantén ese formato.

## Requisitos e instalación

- **Python 3.11 o 3.12** (recomendado; las dependencias fijadas se han verificado con 3.12). Con versiones muy recientes, como 3.15, Ragas no se puede instalar: algunas dependencias (por ejemplo `pyyaml`, que llega a través de `datasets`) aún no publican ruedas para esa versión. pandas 3.x exige Python ≥ 3.11.
- `eval_intent.py` y los modos `--dry-run` **solo usan la librería estándar** (python-dotenv es opcional), así que funcionan con cualquier Python ≥ 3.10 sin instalar nada. Las dependencias pesadas (Ragas, LangChain, pandas) solo se importan al ejecutar la evaluación FAQ real.

Notas sobre las versiones fijadas en `requirements.txt`:

- `langchain-community==0.4.1`: Ragas 0.4.3 importa `langchain_community.chat_models.vertexai`, que desaparece en la 0.4.2 (el paquete está en retirada), así que no se debe actualizar.
- `openai==3.3.0`: es la versión más reciente compatible con `instructor` (dependencia de Ragas); las versiones posteriores arrastran un `jiter` que `instructor` no admite.

Se recomienda un entorno virtual dentro de `eval/` (ya está ignorado en `.gitignore`):

```bash
# Windows (PowerShell)
py -3.12 -m venv eval\.venv
eval\.venv\Scripts\Activate.ps1
python -m pip install -r eval\requirements.txt

# Linux / macOS / Git Bash
python3.12 -m venv eval/.venv
source eval/.venv/bin/activate        # Git Bash en Windows: source eval/.venv/Scripts/activate
python -m pip install -r eval/requirements.txt
```

### Dependencias con hash en GitHub Actions (F33)

El workflow «Evaluación IA» no instala `requirements.txt`, sino `requirements.lock`: los mismos paquetes y todos los indirectos, cada uno con su hash (`pip install --require-hashes`). Si alguien cambiara un paquete publicado, la instalación fallaría en vez de ejecutar su código con la clave de OpenAI.

- El lock es para **Linux y Python 3.12** (lo que usa GitHub). En tu equipo sigue instalando `requirements.txt`: en Windows algunos paquetes necesitan dependencias que el lock de Linux no lleva.
- Si cambias `requirements.txt`, regenera el lock con [uv](https://docs.astral.sh/uv/) (0.13.8 o posterior) desde la raíz del repositorio:

  ```bash
  uv pip compile eval/requirements.txt --python-version 3.12 --python-platform x86_64-unknown-linux-gnu --generate-hashes --output-file eval/requirements.lock
  ```

## Variables de entorno

Se leen del entorno y, si python-dotenv está instalado, también de `eval/.env` y del `.env` de la raíz del repositorio (las variables ya definidas en el entorno tienen prioridad; `eval/.env` tiene prioridad sobre el de la raíz).

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `OPENAI_API_KEY` | Sí (salvo `--dry-run`) | — | Clave de OpenAI. Si falta, los scripts muestran un aviso y **terminan con código 0** (no rompen la CI). |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Modelo de producción evaluado (intención y generación de respuestas FAQ). |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Endpoint compatible con OpenAI (proxy, Azure con capa compatible, etc.). |
| `RAGAS_LLM_MODEL` | No | igual que `OPENAI_MODEL` | Modelo «juez» que usa Ragas para calcular las métricas. |
| `RAGAS_EMBEDDING_MODEL` | No | `text-embedding-3-small` | Modelo de embeddings que usa Ragas (similitud semántica). |

Ejemplo de `eval/.env`:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

## Comandos

Desde la raíz del repositorio (o desde cualquier otro directorio indicando la ruta al script):

```bash
# Validar dataset y renderizado de prompts, sin llamar a la API ni necesitar clave
python eval/eval_intent.py --dry-run
python eval/eval_faq.py --dry-run

# Evaluación completa
python eval/eval_intent.py
python eval/eval_faq.py

# Prueba rápida con las primeras N filas
python eval/eval_intent.py --limit 10
python eval/eval_faq.py --limit 5

# Ajustar el número de peticiones simultáneas (por defecto 4; 1 = secuencial)
python eval/eval_intent.py --concurrency 1
```

Las llamadas a la API se reintentan automáticamente con *backoff* exponencial ante errores 429 (límite de peticiones), 5xx y fallos de red, respetando la cabecera `Retry-After`.

## Salidas

Cada ejecución completa escribe dos ficheros en `eval/results/` con la marca de tiempo de inicio:

- `AAAA-MM-DD_HHMMSS_intent.json` / `AAAA-MM-DD_HHMMSS_intent.md`
- `AAAA-MM-DD_HHMMSS_faq.json` / `AAAA-MM-DD_HHMMSS_faq.md`

El JSON contiene todos los datos (modelo, hash SHA-256 de los prompts usados, métricas, predicciones o respuestas por fila, consumo de tokens) y el Markdown un resumen legible. Los `.json` están ignorados por git; el `.md` puede adjuntarse a un informe o a una PR si interesa conservar el resultado.

En consola se imprime siempre el veredicto **PASS** / **FAIL** frente al objetivo. Por defecto el código de salida es **0 aunque no se alcance el objetivo**: los scripts miden, no bloquean. Con `--strict` (lo usa la CI) terminan con 1 si no se alcanza. Tampoco fallan si falta `OPENAI_API_KEY` (avisan y salen con 0), por lo que se pueden incluir en la CI sin secretos. Solo terminan con código distinto de 0 si el dataset o los prompts no son válidos, si se ejecuta `eval_faq.py` con clave pero sin las dependencias de Ragas instaladas, o por un error inesperado.

Si una fila falla (error de la API tras los reintentos o del juez de Ragas), el error se guarda en el JSON y en el `.md`, y esa fila no cuenta para la media de la métrica (en intención, cuenta como fallo).

## En la CI de GitHub (F22)

El workflow [`.github/workflows/eval.yml`](../.github/workflows/eval.yml) («Evaluación IA») ejecuta las dos evaluaciones con `--strict`. En ese modo, el script termina con código 1 si no se alcanza el objetivo y, en FAQ, también si queda sin puntuar más del 10 % de las filas. Sin `--strict` se comportan como siempre: miden y terminan con 0.

- **Cuándo se ejecuta:** en cada *pull request* o *push* a `main` que toque `apps/bot/src/prompts/`, `packages/db/prisma/seed-data/fisiodemo-faq.txt` o `eval/`. Si no se alcanza el objetivo, el *check* sale en rojo.
- **A mano, con otro modelo:** *Actions → Evaluación IA → Run workflow*. Se elige el modelo a evaluar, el juez de Ragas (por defecto el mismo) y si se evalúa todo, solo la intención o solo las FAQ. Sirve para elegir el sustituto de `gpt-4o-mini` antes del 14/01/2027: se lanza una vez por candidato y se comparan los informes.
- **Informes:** el resumen de cada ejecución aparece en la página del *run* (`GITHUB_STEP_SUMMARY`). Los `.json` y `.md` completos se guardan 30 días como artefacto `evaluacion-ia-<modelo>-<n>`.
- **Configuración:**
  - Secreto del repositorio `OPENAI_API_KEY` (*Settings → Secrets and variables → Actions*). Sin él, el *job* se marca como omitido y no falla. Tampoco hay secretos en las *pull requests* desde *forks*.
  - Variable del repositorio `OPENAI_MODEL`, con el modelo de producción. Si falta, se usa `gpt-4o-mini`.
- **Coste aproximado** de una ejecución completa con `gpt-4o-mini` como modelo y como juez. Es una estimación por el tamaño de los prompts: los tokens del juez de Ragas no se miden.
  - Intención: 100 llamadas de unos 700 tokens.
  - FAQ: 30 respuestas de unos 550 tokens, y unas 5 llamadas del juez por fila.
  - Total: unos 250 000–300 000 tokens de entrada y unos 25 000 de salida. A 0,15 $ y 0,60 $ por millón (precios de OpenAI consultados el 12/11/2026), unos **5 céntimos de dólar**; los *embeddings* son despreciables.
  - Con modelos más caros, el coste sube en proporción.

## Cómo interpretar los resultados

**Intención**

- La **accuracy** es la proporción de mensajes clasificados exactamente como en `ground_truth`. Con 100 filas, el objetivo del 99 % admite como máximo un fallo.
- En la **matriz de confusión** (filas = valor real, columnas = predicción) el error más costoso es `CITA → FAQ`: el cliente quería reservar y el bot le contesta con información. `FAQ → CITA` es más leve (se abre el flujo de reserva y el cliente puede salir).
- «Salidas no válidas» cuenta las respuestas del modelo que no eran `CITA`/`FAQ` y se normalizaron a `FAQ`; si aparecen, conviene revisar el formato de salida del prompt.
- Ante un fallo, revisa la fila: puede ser un error del prompt (añadir una regla o un ejemplo) o una etiqueta discutible en el dataset.

**FAQ (Ragas)**

- **`answer_relevancy`** (0–1): mide si la respuesta contesta a lo que se preguntó. Ragas genera preguntas a partir de la respuesta y compara sus embeddings con la pregunta original; penaliza las respuestas evasivas («no estoy seguro…»). Como las preguntas generadas pueden no estar en el mismo idioma o registro que la original, en español los valores suelen quedar por debajo de los obtenidos en inglés: 0,75 es un valor razonable para respuestas de una frase.
- **`answer_correctness`** (0–1): combina la corrección factual frente a la respuesta de referencia (afirmaciones verdaderas/falsas/omitidas, F1) con la similitud semántica. Penaliza datos inventados (horarios, precios, aseguradoras) y omisiones.
- Las métricas usan un LLM como juez, así que hay cierta variabilidad entre ejecuciones (además, la generación usa `temperature = 0.3`, como en producción). Compara medias de varias ejecuciones antes de sacar conclusiones y revisa en el `.md` las filas con peor puntuación.
- Si sube `answer_correctness` pero baja `answer_relevancy`, el modelo probablemente está añadiendo información correcta pero no pedida (o al revés).

## Estructura

```
eval/
├── README.md
├── requirements.txt
├── eval_common.py      # utilidades compartidas (rutas, .env, cliente HTTP con reintentos, resultados)
├── eval_intent.py      # evaluación de intención CITA/FAQ
├── eval_faq.py         # evaluación de respuestas FAQ con Ragas
├── data/
│   ├── intent.csv
│   └── faq.csv
└── results/            # salidas de cada ejecución
    └── .gitkeep
```
