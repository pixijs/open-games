export default {
    server: {
        host: true,
        port: 8000
    },
    define: {
        APP_VERSION: JSON.stringify(process.env.npm_package_version),
    },
}