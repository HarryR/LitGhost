// Vaguely extracted from https://telegram.org/js/telegram-web-app.js?59

function urlSafeDecode(urlencoded:string) {
    try {
      urlencoded = urlencoded.replace(/\+/g, '%20');
      return decodeURIComponent(urlencoded);
    } catch (e) {
      return urlencoded;
    }
}

function urlParseHashParams(locationHash:string) {
    locationHash = locationHash.replace(/^#/, '');
    var params:any = {};
    if (!locationHash.length) {
        return params;
    }
    if (locationHash.indexOf('=') < 0 && locationHash.indexOf('?') < 0) {
        params._path = urlSafeDecode(locationHash);
        return params;
    }
    var qIndex = locationHash.indexOf('?');
    if (qIndex >= 0) {
        var pathParam = locationHash.substr(0, qIndex);
        params._path = urlSafeDecode(pathParam);
        locationHash = locationHash.substr(qIndex + 1);
    }
    var query_params = urlParseQueryString(locationHash);
    for (var k in query_params) {
        params[k] = query_params[k];
    }
    return params;
}

 function urlParseQueryString(queryString:string) {
    var params:any = {};
    if (!queryString.length) {
      return params;
    }
    var queryStringParams = queryString.split('&');
    var i, param, paramName, paramValue;
    for (i = 0; i < queryStringParams.length; i++) {
      param = queryStringParams[i].split('=');
      paramName = urlSafeDecode(param[0]);
      paramValue = param[1] == null ? null : urlSafeDecode(param[1]);
      params[paramName] = paramValue;
    }
    return params;
  }

export function detectTg():boolean {
    var locationHash = '';
    try {
        locationHash = location.hash.toString();
    } catch (e) {}

    var initParams = urlParseHashParams(locationHash);

    return initParams.tgWebAppData && initParams.tgWebAppData.length;
}