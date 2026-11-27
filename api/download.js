const BUCKET = "txt-files";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(res, status, payload) {
    res.status(status).json(payload);
}

async function responseJson(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function storageObjectPath(path) {
    const segments = path.split("/");
    if (segments.length < 2 || segments.some(segment =>
        !segment || segment === "." || segment === "..")) {
        throw new Error("Invalid stored pack path.");
    }
    return segments.map(encodeURIComponent).join("/");
}

module.exports = async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return respond(res, 405, { error: "Method not allowed." });
    }

    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
        console.error("Download endpoint is missing Supabase server environment variables.");
        return respond(res, 500, { error: "Downloads are temporarily unavailable." });
    }

    let body = req.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            return respond(res, 400, { error: "Invalid request body." });
        }
    }

    const packId = body?.packId;
    if (typeof packId !== "string" || !UUID_PATTERN.test(packId)) {
        return respond(res, 400, { error: "Invalid pack ID." });
    }

    const headers = {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json"
    };

    try {
        const packQuery = new URLSearchParams({
            select: "id,title,file_path",
            id: `eq.${packId}`,
            published: "eq.true"
        });
        const packResponse = await fetch(
            `${supabaseUrl}/rest/v1/txt_packs?${packQuery.toString()}`,
            { headers }
        );
        if (!packResponse.ok) {
            console.error("Could not retrieve the requested published pack:", await responseJson(packResponse));
            return respond(res, 502, { error: "Could not prepare this download." });
        }

        const [pack] = await responseJson(packResponse) || [];
        if (!pack || typeof pack.file_path !== "string" || !pack.file_path.toLowerCase().endsWith(".zip")) {
            return respond(res, 404, { error: "This pack is not available for download." });
        }

        const signedResponse = await fetch(
            `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${storageObjectPath(pack.file_path)}`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({ expiresIn: 60 })
            }
        );
        const signedData = await responseJson(signedResponse);
        if (!signedResponse.ok || typeof signedData?.signedURL !== "string") {
            console.error("Could not create a signed pack URL:", signedData);
            return respond(res, 502, { error: "Could not prepare this download." });
        }

        const signedUrl = new URL(signedData.signedURL, `${supabaseUrl}/`);
        const safeTitle = String(pack.title || "texture-pack")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .trim() || "texture-pack";
        signedUrl.searchParams.set("download", `${safeTitle}.zip`);

        const countResponse = await fetch(
            `${supabaseUrl}/rest/v1/rpc/increment_pack_download`,
            {
                method: "POST",
                headers,
                body: JSON.stringify({ p_pack_id: pack.id })
            }
        );
        const downloadCount = await responseJson(countResponse);
        if (!countResponse.ok || !Number.isSafeInteger(Number(downloadCount)) || Number(downloadCount) < 1) {
            console.error("Could not record the prepared pack download:", downloadCount);
            return respond(res, 503, { error: "Could not record this download. Please try again." });
        }

        return respond(res, 200, {
            signedUrl: signedUrl.toString(),
            downloadCount: Number(downloadCount)
        });
    } catch (error) {
        console.error("Download endpoint failed:", error);
        return respond(res, 500, { error: "Downloads are temporarily unavailable." });
    }
};
