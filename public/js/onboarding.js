const hardwareCode = `#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* WRITE_API_KEY = "YOUR_WRITE_API_KEY";
const char* SERVER_URL = "https://sarkitcloud.onrender.com/update";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("Connected");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    float sensorValue = analogRead(34) * (3.3 / 4095.0);

    String url = String(SERVER_URL) + "?api_key=" + WRITE_API_KEY +
                  "&device_id=esp32-01&field1=" + String(sensorValue);

    http.begin(url);
    int httpCode = http.GET();
    Serial.println(httpCode);
    http.end();
  }
  delay(15000);
}`;

const hardwareCodeBox = document.getElementById('hardwareCode');
if (hardwareCodeBox) hardwareCodeBox.textContent = hardwareCode;

async function copyCode(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const original = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1200);
}

const copyHardwareBtn = document.getElementById('copyHardwareBtn');
if (copyHardwareBtn) copyHardwareBtn.addEventListener('click', () => copyCode(hardwareCode, copyHardwareBtn));