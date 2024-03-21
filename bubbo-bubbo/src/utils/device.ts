export const device = {
    /**
     * Indicates if the device is a mobile device or not.
     * @returns true if the device is mobile, false otherwise.
     */
    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Windows Phone|Opera Mini/i.test(navigator.userAgent);
    },
};
