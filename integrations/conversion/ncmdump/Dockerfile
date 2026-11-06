FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:212fe4cb74627d5adf9817a4088906ae3edff1bd853bb27565d4b46731efe61e AS build
WORKDIR /src
COPY . .
RUN dotnet restore NcmGateway.csproj -p:PublishAot=false -p:RestorePackagesWithLockFile=true --locked-mode \
    && dotnet publish NcmGateway.csproj -c Release -p:PublishAot=false --no-restore -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:1a48394b6f29d3a32c79d9edecd4abda0ecbe8776d567dbfc4590ed6979c740c
WORKDIR /app
COPY --from=build /out .
COPY vendor/LICENSE.txt /app/licenses/LibNCM.MIT.txt
COPY licenses/ /app/licenses/
COPY THIRD_PARTY.md /app/licenses/THIRD_PARTY.md
ENV ASPNETCORE_URLS=http://+:8080 \
    NCM_TEMP_ROOT=/tmp/hulinger-ncm \
    NCM_MAX_FILE_BYTES=536870912 \
    NCM_TIMEOUT_SECONDS=300 \
    DOTNET_EnableDiagnostics=0
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "NcmGateway.dll"]
