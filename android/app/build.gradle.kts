import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing lives outside the repo: SHELF_KEYSTORE names a properties
// file with storeFile, storePassword, keyAlias and keyPassword.
val signing = System.getenv("SHELF_KEYSTORE")?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}

android {
    namespace = "com.th3rumbl3.shelf"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.th3rumbl3.shelf"
        minSdk = 29
        targetSdk = 34
        versionCode = 3
        versionName = "0.3.0"
        // at home the app talks to shelf directly, elsewhere through the public edge:
        // -PshelfLanUrl=http://shelf.lan -PshelfPublicUrl=https://shelf.example.com (the LAN
        // host also goes in res/xml/network.xml, the one plain-http exception);
        // -PshelfUrl=http://… points a test build at a test shelf for both
        val test = findProperty("shelfUrl") as String?
        val lan = findProperty("shelfLanUrl") as String? ?: "http://shelf.lan"
        val public = findProperty("shelfPublicUrl") as String? ?: "https://shelf.example.com"
        buildConfigField("String", "LAN_URL", "\"${test ?: lan}\"")
        buildConfigField("String", "PUBLIC_URL", "\"${test ?: public}\"")
    }

    signingConfigs {
        if (signing != null) create("release") {
            storeFile = file(signing.getProperty("storeFile"))
            storePassword = signing.getProperty("storePassword")
            keyAlias = signing.getProperty("keyAlias")
            keyPassword = signing.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.findByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}
