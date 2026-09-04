from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView

class MyTokenObtainPairSerializer(TokenObtainPairSerializer):
    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["is_staff"] = user.is_staff
        token["roles"] = list(user.groups.values_list("name", flat=True))
        return token

class MyTokenView(TokenObtainPairView):
    serializer_class = MyTokenObtainPairSerializer