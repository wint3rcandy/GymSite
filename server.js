const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT) || 3001;
const ROOT_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, "data");
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, "workouts.json");

const EXERCISES = [
  "Bench",
  "Squat",
  "Deadlift",
  "RDL's",
  "Machine Rows",
  "Lat Pull Downs",
  "Hamstring Curls",
  "Knee Extensions",
  "Leg Press",
  "Hanging Knee Raises",
  "Tricep Extensions",
  "Overhead Tricep Extensions",
  "Spider Curls",
  "Standing Dumbbell Curls",
  "Close-Grip Bench",
  "Lateral Raises",
  "Machine Lateral Raises",
  "Reverse Pec Deck",
  "Paused Deadlifts",
  "Deficit Deadlifts",
  "Zone 2"
];
const ZONE2_EXERCISE = "Zone 2";
const BODYWEIGHT_TOKENS = new Set(["bodyweight", "body", "bw", "bwt"]);

const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/progress.html": "progress.html"
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");

    if (request.method === "GET" && requestUrl.pathname === "/api/workouts") {
      return sendJson(response, 200, await readStore());
    }

    if (request.method === "PUT") {
      const routeMatch = requestUrl.pathname.match(/^\/api\/workouts\/(drafts|sessions)\/(\d{4}-\d{2}-\d{2})$/);

      if (routeMatch) {
        const [, bucket, date] = routeMatch;
        const body = await readJsonBody(request);
        const entries = sanitizeEntries(body.entries);
        const store = await readStore();

        if (bucket === "drafts") {
          if (entries.length) {
            store.draftSessions[date] = entries;
          } else {
            delete store.draftSessions[date];
          }
        } else if (entries.length) {
          store.savedSessions[date] = entries;
          store.draftSessions[date] = cloneEntries(entries);
        } else {
          delete store.savedSessions[date];
          delete store.draftSessions[date];
        }

        return sendJson(response, 200, await writeStore(store));
      }
    }

    if (request.method === "GET" && STATIC_FILES[requestUrl.pathname]) {
      return serveStaticFile(response, path.join(ROOT_DIR, STATIC_FILES[requestUrl.pathname]));
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const publicMessage = error.publicMessage || "Internal server error";

    console.error(error);
    sendJson(response, statusCode, { error: publicMessage });
  }
});

server.listen(PORT, async () => {
  await ensureDataFile();
  console.log("Gym tracker running at http://localhost:" + PORT);
});

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch (error) {
    await writeStore(createDefaultStore());
  }
}

function createDefaultStore() {
  return {
    savedSessions: {},
    draftSessions: {},
    updatedAt: new Date().toISOString()
  };
}

async function readStore() {
  await ensureDataFile();

  try {
    const fileContents = await fs.readFile(DATA_FILE, "utf8");
    return normalizeStore(JSON.parse(fileContents));
  } catch (error) {
    const fallbackStore = createDefaultStore();
    await writeStore(fallbackStore);
    return fallbackStore;
  }
}

async function writeStore(store) {
  const normalizedStore = normalizeStore(store);
  normalizedStore.updatedAt = new Date().toISOString();

  const tempFile = DATA_FILE + ".tmp";
  await fs.writeFile(tempFile, JSON.stringify(normalizedStore, null, 2), "utf8");
  await fs.rename(tempFile, DATA_FILE);

  return normalizedStore;
}

function normalizeStore(store) {
  return {
    savedSessions: normalizeBucket(store && store.savedSessions),
    draftSessions: normalizeBucket(store && store.draftSessions),
    updatedAt: store && typeof store.updatedAt === "string" ? store.updatedAt : new Date().toISOString()
  };
}

function normalizeBucket(bucket) {
  const normalizedBucket = {};

  if (!bucket || typeof bucket !== "object") {
    return normalizedBucket;
  }

  Object.keys(bucket).sort().forEach((date) => {
    if (!isValidDate(date)) {
      return;
    }

    const entries = sanitizeEntries(bucket[date]);
    if (entries.length) {
      normalizedBucket[date] = entries;
    }
  });

  return normalizedBucket;
}

function sanitizeEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries.map((entry, index) => {
    const exercise = EXERCISES.includes(entry && entry.exercise) ? entry.exercise : null;
    const id = typeof entry.id === "string" && entry.id ? entry.id.slice(0, 120) : "entry-" + Date.now() + "-" + index;

    if (isZone2Exercise(exercise)) {
      const grade = parseCardioMetric(entry && entry.grade, true);
      const speed = parseCardioMetric(entry && entry.speed);
      const duration = parseCardioMetric(entry && entry.duration);

      if (grade === null || speed === null || duration === null) {
        return null;
      }

      return {
        id,
        exercise,
        entryType: "zone2",
        grade,
        speed,
        duration,
        status: "completed"
      };
    }

    const sets = Number(entry && entry.sets);
    const reps = Number(entry && entry.reps);
    const weightType = normalizeWeightType(entry);
    const weight = weightType === "bodyweight" ? null : Number(entry && entry.weight);
    const status = entry && entry.status === "failed" ? "failed" : "completed";

    if (
      !exercise ||
      !Number.isFinite(sets) ||
      !Number.isInteger(sets) ||
      sets < 1 ||
      !Number.isFinite(reps) ||
      !Number.isInteger(reps) ||
      reps < 1
    ) {
      return null;
    }

    if (weightType === "loaded" && (!Number.isFinite(weight) || weight < 0)) {
      return null;
    }

    return {
      id,
      exercise,
      entryType: "strength",
      sets,
      reps,
      weight: weightType === "bodyweight"
        ? null
        : (Number.isInteger(weight) ? weight : Number(weight.toFixed(1))),
      weightType,
      status
    };
  }).filter(Boolean);
}

function normalizeWeightType(entry) {
  if (entry && entry.weightType === "bodyweight") {
    return "bodyweight";
  }

  if (entry && typeof entry.weight === "string") {
    const condensed = entry.weight.toLowerCase().replace(/\s+/g, "");
    if (BODYWEIGHT_TOKENS.has(condensed)) {
      return "bodyweight";
    }
  }

  return "loaded";
}

function parseCardioMetric(value, allowZero = false) {
  const numericValue = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  if (allowZero ? numericValue < 0 : numericValue <= 0) {
    return null;
  }

  return Number.isInteger(numericValue) ? numericValue : Number(numericValue.toFixed(1));
}

function isZone2Exercise(exercise) {
  return exercise === ZONE2_EXERCISE;
}

function cloneEntries(entries) {
  return entries.map((entry) => ({ ...entry }));
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value + "T12:00:00").valueOf());
}

async function readJsonBody(request) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > 1_000_000) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      error.publicMessage = "Request body too large";
      throw error;
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    error.statusCode = 400;
    error.publicMessage = "Invalid JSON body";
    throw error;
  }
}

async function serveStaticFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
  const fileContents = await fs.readFile(filePath);

  response.writeHead(200, { "Content-Type": contentType });
  response.end(fileContents);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}
