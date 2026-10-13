# A made-up external app (#87): what an app from another repository looks like to the OS. It serves
# its two health paths and a page (its worker runs the same image), declares a database and one
# secret, and carries its manifest in the OCI label the installer reads:
#   docker build --label "org.asafarim.app.manifest=$(cat platform.app.json)" -t ext-demo:ci tools/platform-cli/fixtures/external-app
# Used by `pnpm e2e` (the Status board) and the CLI's tests; it is never deployed.
FROM busybox:1.37
COPY www /www
USER 65534
EXPOSE 4120
CMD ["httpd", "-f", "-v", "-p", "4120", "-h", "/www"]
