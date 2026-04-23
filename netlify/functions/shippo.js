exports.handler = async function(event) {
  const SHIPPO_KEY = "shippo_live_580b507fb6bea4d8bef9703bc135f42cab86f307";
  
  const { carrier, trackingNo } = JSON.parse(event.body || "{}");
  
  if(!carrier || !trackingNo) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing carrier or trackingNo" }) };
  }

  try {
    const resp = await fetch(`https://api.goshippo.com/tracks/${carrier}/${trackingNo}`, {
      headers: { "Authorization": `ShippoToken ${SHIPPO_KEY}` }
    });
    const data = await resp.json();
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data)
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
