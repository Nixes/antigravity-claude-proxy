$body = @{
    model = "gemini-3.1-flash-lite"
    messages = @(
        @{ role = "user"; content = "What are the top 3 news headlines today?" }
    )
    google_search = $true
} | ConvertTo-Json -Depth 5
$response = Invoke-RestMethod -Uri "http://localhost:8080/v1/chat/completions" `
    -Method Post `
    -Headers @{ "Content-Type" = "application/json"; "Authorization" = "Bearer test" } `
    -Body $body
# Print the full response as formatted JSON
$response | ConvertTo-Json -Depth 10